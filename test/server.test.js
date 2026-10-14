const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { makeHookEvent, runHook } = require('../src/hooks/event');
const { productFromCwd } = require('../src/server/identity');
const { DashboardState } = require('../src/server/state');
const { readTranscriptInterruption } = require('../src/server/transcript');
const {
  startServer,
  MAX_BODY_BYTES,
  escapeHtmlAttribute,
  hasSessionJsonFiles,
} = require('../src/server/server');
const { hookHeaders, jsonBody, request, startTestServer, uiHeaders } = require('./support/server');
const { temporaryHome: createTemporaryHome } = require('./support/temp');

test('Claude の SessionStart と Stop の後にモデルを読み、読めないときは前の札を保つ', async (t) => {
  const state = new DashboardState();
  const reads = [];
  let model = 'claude-opus-5-5';
  const runtime = await runningServer(t, { state, sessionModelDelayMs: 1,
    readSessionModel: async (home, cwd, id) => { reads.push({ cwd, id }); return model && { model, at: Date.now() }; },
  });
  state.syncSessionFiles([{ session_id: 'main-model', cwd: runtime.homeDir }]);
  const send = async hook_event_name => request(runtime.info.port, {
    method: 'POST', path: '/api/events', headers: hookHeaders(runtime.info.secret),
    body: JSON.stringify({ session_id: 'main-model', hook_event_name, model: 'claude-sonnet-5-5' }),
  });
  await send('SessionStart');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(state.snapshot().sessions[0].modelName, 'Opus 5.5');
  model = 'claude-sonnet-5-5';
  await send('Stop');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(state.snapshot().sessions[0].modelName, 'Sonnet 5.5');
  model = null;
  await send('Stop');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(state.snapshot().sessions[0].modelName, 'Sonnet 5.5');
  assert.deepEqual(reads, Array(3).fill({ cwd: runtime.homeDir, id: 'main-model' }));
});

test('サーバー起動時に見える Claude のモデルを読み、Codex は読まない', async (t) => {
  const state = new DashboardState();
  for (const provider of ['claude', 'codex']) state.addEvent({ session_id: provider, provider, hook_event_name: 'SessionStart' });
  const reads = [];
  await runningServer(t, { state, sessionModelDelayMs: 1,
    readSessionModel: async (home, cwd, id) => { reads.push(id); return { model: 'claude-opus-5-5', at: Date.now() }; },
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(reads, ['claude']);
  assert.equal(state.snapshot().sessions.find(session => session.session_id === 'claude').modelName, 'Opus 5.5');
});

test('モデルの読み取り中の Stop は同じセッションの読み取りを重ねずに再読する', async (t) => {
  const state = new DashboardState();
  let release;
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  let reads = 0;
  let active = 0;
  let maxActive = 0;
  const runtime = await runningServer(t, { state, sessionModelDelayMs: 1, readSessionModel: async () => {
    reads += 1; active += 1; maxActive = Math.max(maxActive, active);
    if (reads === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    active -= 1; return { model: 'claude-opus-5-5', at: Date.now() };
  } });
  const send = () => request(runtime.info.port, { method: 'POST', path: '/api/events', headers: hookHeaders(runtime.info.secret),
    body: JSON.stringify({ session_id: 'serial-model', hook_event_name: 'Stop' }) });
  await send(); await firstStarted;
  await send(); await send();
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reads, 2);
  assert.equal(maxActive, 1);
});

test('待機中で稼働中の Claude サブエージェントがあるセッションだけ、メインのイベントの後に記録を読む', async (t) => {
  const state = new DashboardState();
  const reads = [];
  const runtime = await runningServer(t, {
    state, taskNotificationDelayMs: 10,
    readTaskNotifications: async (home, cwd, id) => {
      reads.push({ cwd, id });
      return new Map([['claude-task', { status: 'killed', recordedAt: null }]]);
    },
  });
  state.syncSessionFiles(['waiting-claude', 'working-claude', 'ended-claude', 'waiting-codex', 'agent-event-only'].map(session_id => ({ session_id, cwd: runtime.homeDir })));
  const send = async (session_id, event) => {
    const response = await request(runtime.info.port, {
      method: 'POST', path: '/api/events', headers: hookHeaders(runtime.info.secret),
      body: JSON.stringify({ session_id, ...event }),
    });
    assert.equal(response.status, 202);
  };
  for (const id of ['waiting-claude', 'working-claude', 'ended-claude']) {
    await send(id, { hook_event_name: 'SubagentStart', agent_id: 'claude-task' });
  }
  await send('ended-claude', { hook_event_name: 'SubagentStop', agent_id: 'claude-task' });
  await send('ended-claude', { hook_event_name: 'Stop' });
  await send('waiting-codex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'codex-launch', summary: 'bash ~/.claude/tools/codex-agent.sh impl-hard' });
  await send('waiting-codex', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'codex-launch' });
  await send('waiting-codex', { hook_event_name: 'Stop' });
  await send('waiting-claude', { hook_event_name: 'Stop' });
  await send('agent-event-only', { hook_event_name: 'Stop' });
  await send('agent-event-only', { hook_event_name: 'SubagentStart', agent_id: 'claude-task' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(reads, [{ cwd: runtime.homeDir, id: 'waiting-claude' }]);
  assert.equal(state.snapshot().sessions.find(session => session.session_id === 'waiting-claude').status, '待機中');
});

// 中断の検出は、フックの状態、セッションファイル、transcript の三つがそろったときだけ働く。
async function interruptionCockpit(t, options = {}) {
  const reads = [];
  const runtime = await runningServer(t, {
    ...options,
    readTranscriptInterruption: async (home, cwd, id) => {
      reads.push(id);
      return readTranscriptInterruption(home, cwd, id);
    },
  });
  const claudeHome = path.join(runtime.homeDir, '.claude');
  const base = Date.now() - 60_000;
  const projectDirectory = path.join(claudeHome, 'projects', runtime.homeDir.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.mkdir(path.join(claudeHome, 'sessions'), { recursive: true });
  const row = (type, offset, content) => JSON.stringify({
    type, timestamp: new Date(base + offset).toISOString(),
    message: { role: type, stop_reason: type === 'assistant' ? 'end_turn' : null, content },
  });
  return {
    runtime, reads, base,
    interruptedRow: (offset) => row('user', offset, [{ type: 'text', text: '[Request interrupted by user]' }]),
    promptRow: (offset) => row('user', offset, [{ type: 'text', text: '続きをお願いします' }]),
    answerRow: (offset) => row('assistant', offset, [{ type: 'text', text: '完了しました' }]),
    async transcript(id, rows) {
      await fs.writeFile(path.join(projectDirectory, `${id}.jsonl`), `${rows.join('\n')}\n`);
    },
    async sessionFile(id, status, statusOffset) {
      await fs.writeFile(path.join(claudeHome, 'sessions', `${id}.json`), JSON.stringify({
        sessionId: id, pid: process.pid, cwd: runtime.homeDir, status,
        updatedAt: base + statusOffset, statusUpdatedAt: base + statusOffset,
      }));
    },
    async hook(id, event, offset, fields = {}) {
      const response = await request(runtime.info.port, {
        method: 'POST', path: '/api/events', headers: hookHeaders(runtime.info.secret),
        body: JSON.stringify({ session_id: id, hook_event_name: event, hookAt: base + offset, ...fields }),
      });
      assert.equal(response.status, 202);
    },
    status: (id) => runtime.state.snapshot().sessions.find(session => session.session_id === id),
  };
}

test('ファイルが idle になり transcript の最後が中断の行のセッションを、その行の時刻で中断にして解除まで保つ', async (t) => {
  const c = await interruptionCockpit(t);
  await c.hook('main', 'UserPromptSubmit', 0);
  await c.transcript('main', [c.promptRow(0), c.interruptedRow(2000)]);

  await c.sessionFile('main', 'busy', 1000);
  await c.runtime.refreshSessionFiles();
  assert.equal(c.status('main').status, '作業中');
  assert.deepEqual(c.reads, []);

  await c.sessionFile('main', 'idle', 5000);
  await c.runtime.refreshSessionFiles();
  const interrupted = c.status('main');
  assert.equal(interrupted.status, '中断');
  assert.equal(interrupted.lastActivityAt, new Date(c.base + 2000).toISOString());

  await c.runtime.refreshSessionFiles();
  assert.deepEqual(c.reads, ['main']);
  assert.equal(c.status('main').status, '中断');

  await c.hook('main', 'UserPromptSubmit', 10_000);
  assert.equal(c.status('main').status, '作業中');
  await c.runtime.refreshSessionFiles();
  assert.equal(c.status('main').status, '作業中');
  assert.deepEqual(c.reads, ['main']);

  const rows = await jsonBody(await request(c.runtime.info.port, { path: '/api/state' })).sessions;
  assert.equal(rows.find(session => session.session_id === 'main').status, '作業中');
});

test('中断を誤検出しない: 最後の入力より前の中断の行、busy のまま、区切りより古い idle の時刻、中断の行ではない末尾', async (t) => {
  const c = await interruptionCockpit(t);
  for (const id of ['before-prompt', 'still-busy', 'old-idle', 'plain-end']) await c.hook(id, 'UserPromptSubmit', 0);
  await c.transcript('before-prompt', [c.interruptedRow(-5000)]);
  await c.sessionFile('before-prompt', 'idle', 5000);
  await c.transcript('still-busy', [c.promptRow(0), c.interruptedRow(2000)]);
  await c.sessionFile('still-busy', 'busy', 5000);
  await c.transcript('old-idle', [c.promptRow(0), c.interruptedRow(2000)]);
  await c.sessionFile('old-idle', 'idle', -1000);
  await c.transcript('plain-end', [c.promptRow(0), c.answerRow(2000)]);
  await c.sessionFile('plain-end', 'idle', 5000);

  await c.runtime.refreshSessionFiles();
  for (const id of ['before-prompt', 'still-busy', 'old-idle', 'plain-end']) assert.equal(c.status(id).status, '作業中', id);
  // Stop の取りこぼしは対象にしないが、transcript は idle の時刻ごとに一度だけ読む。
  assert.deepEqual(c.reads.sort(), ['before-prompt', 'plain-end']);
});

test('transcript に中断の行が idle より遅れて書かれても、idle の時刻が同じまま次の更新で中断にする', async (t) => {
  const c = await interruptionCockpit(t);
  await c.hook('late', 'UserPromptSubmit', 0);
  await c.transcript('late', [c.promptRow(0)]);
  await c.sessionFile('late', 'idle', 3000);
  await c.runtime.refreshSessionFiles();
  assert.equal(c.status('late').status, '作業中');

  await c.transcript('late', [c.promptRow(0), c.interruptedRow(3200)]);
  await c.runtime.refreshSessionFiles();
  assert.equal(c.status('late').status, '中断');
  assert.deepEqual(c.reads, ['late', 'late']);
});

test('transcript の末尾が idle より新しいか、idle から猶予を過ぎたら、同じ idle の時刻では読み直さない', async (t) => {
  const c = await interruptionCockpit(t);
  await c.hook('answered', 'UserPromptSubmit', 0);
  await c.transcript('answered', [c.promptRow(0), c.answerRow(4000)]);
  await c.sessionFile('answered', 'idle', 3000);
  await c.hook('stale', 'UserPromptSubmit', -200_000);
  await c.transcript('stale', [c.promptRow(-200_000)]);
  await c.sessionFile('stale', 'idle', -100_000);
  await c.runtime.refreshSessionFiles();
  await c.runtime.refreshSessionFiles();
  assert.deepEqual(c.reads.sort(), ['answered', 'stale']);
  for (const id of ['answered', 'stale']) assert.equal(c.status(id).status, '作業中', id);
});

test('中断中のセッションも、稼働中のサブエージェントの完了通知を transcript から取り込む', async (t) => {
  const notificationReads = [];
  const c = await interruptionCockpit(t, {
    taskNotificationDelayMs: 5,
    readTaskNotifications: async (home, cwd, id) => {
      notificationReads.push(id);
      return new Map([['bg-task', { status: 'completed', recordedAt: null }]]);
    },
  });
  await c.hook('bg', 'UserPromptSubmit', 0);
  await c.hook('bg', 'SubagentStart', 100, { agent_id: 'bg-task', agent_type: 'impl' });
  await c.transcript('bg', [c.promptRow(0), c.interruptedRow(2000)]);
  await c.sessionFile('bg', 'idle', 5000);
  await c.runtime.refreshSessionFiles();
  await new Promise(resolve => setTimeout(resolve, 80));

  assert.ok(notificationReads.includes('bg'));
  const session = c.status('bg');
  assert.equal(session.status, '中断');
  assert.equal(session.agents[0].active, false);
});

async function temporaryHome(testContext, { deferCleanup = false } = {}) {
  return createTemporaryHome(testContext, 'agent-cockpit-test-', {
    deferCleanup,
    environment: { AGENT_COCKPIT_HOME: (homeDir) => homeDir },
  });
}

test('記録削除 API は秘密値と Origin と本文を厳密に検証する', async (t) => {
  const runtime = await runningServer(t);
  const send = (body, headers = uiHeaders(runtime.info, `http://127.0.0.1:${runtime.info.port}`)) => request(runtime.info.port, {
    method: 'POST', path: '/api/record-deletions', headers, body: JSON.stringify(body),
  });
  assert.equal((await send({ session_ids: ['unknown'] }, {})).status, 401);
  assert.equal((await send({ session_ids: ['unknown'] }, uiHeaders(runtime.info, 'https://other.example'))).status, 403);
  const noOrigin = uiHeaders(runtime.info, `http://127.0.0.1:${runtime.info.port}`);
  delete noOrigin.origin;
  assert.equal((await send({ session_ids: ['unknown'] }, noOrigin)).status, 403);
  const pr = { owner: 'example', repo: 'project', number: 31 };
  for (const body of [null, [], {}, { session_ids: [] }, { session_ids: ['unknown'], extra: true },
    { session_ids: 'unknown' }, { session_ids: ['../invalid'] }, { session_ids: Array(51).fill('unknown') },
    { merge_history: [{ ...pr, extra: true }] }, { merge_history: [{ ...pr, number: 0 }] },
    { merge_history: Array(51).fill(pr) }, { closed_pull_requests: [{ ...pr, owner: '../invalid' }] },
    { closed_pull_requests: Array(51).fill(pr) }, { closed_pull_requests: [null] }]) {
    assert.equal((await send(body)).status, 400, JSON.stringify(body));
  }
  const unknown = await send({ session_ids: ['unknown'], merge_history: [pr], closed_pull_requests: [pr] });
  assert.equal(unknown.status, 200);
  assert.deepEqual(jsonBody(unknown), { deleted: { sessions: 0, pullRequests: 0 } });
});

test('記録削除 API は指定 ID だけを削除し、待機の解除と PR グループ更新を行う', async (t) => {
  const state = new DashboardState();
  const ended = [];
  const refreshed = [];
  const runtime = await runningServer(t, {
    state,
    answerDelivery: { sessionEnded: (...args) => ended.push(args), sessionReopened() {}, close() {} },
    pullRequestTracker: { snapshot: () => [], refreshReviewGroups: async (...args) => refreshed.push(args), close() {}, start() {} },
  });
  const now = Date.now();
  state.syncSessionFiles([{ session_id: 'delete-this', updatedAt: new Date(now - 10).toISOString() }, { session_id: 'keep-this' }], now);
  state.registerPullRequest('delete-this', { url: 'https://github.com/example/project/pull/31' }, {}, now);
  state.updatePullRequest('delete-this', 'example', 'project', 31, { state: 'closed' });
  state.recordMergedPullRequest({ owner: 'example', repo: 'project', number: 32,
    url: 'https://github.com/example/project/pull/32', mergedAt: new Date(now).toISOString() }, now);
  const pr = number => ({ owner: 'example', repo: 'project', number });
  const response = await request(runtime.info.port, {
    method: 'POST', path: '/api/record-deletions', headers: uiHeaders(runtime.info, `http://127.0.0.1:${runtime.info.port}`),
    body: JSON.stringify({ session_ids: ['delete-this', 'delete-this', 'unknown'], merge_history: [pr(32), pr(32)], closed_pull_requests: [pr(31), pr(31)] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(jsonBody(response), { deleted: { sessions: 1, pullRequests: 2 } });
  assert.deepEqual(state.snapshot().sessions.map(session => session.session_id), ['keep-this']);
  assert.deepEqual(state.mergedPullRequestHistoryForRepo('example', 'project'), []);
  assert.deepEqual(refreshed, [['example', 'project']]);
  assert.equal(ended.length, 1);
  assert.equal(ended[0][0], 'delete-this');
});

test('記録削除後の PR グループ更新が失敗しても他のリポジトリを試し 200 を返す', async (t) => {
  const state = new DashboardState();
  const refreshAttempts = [];
  for (const repo of ['first', 'second']) {
    state.registerPullRequest('refresh-failure', { url: `https://github.com/example/${repo}/pull/31` });
    state.updatePullRequest('refresh-failure', 'example', repo, 31, { state: 'closed' });
  }
  const runtime = await runningServer(t, {
    state,
    pullRequestTracker: {
      snapshot: () => [],
      async refreshReviewGroups(owner, repo) {
        refreshAttempts.push([owner, repo]);
        if (repo === 'first') throw new Error('refresh failed');
      },
      close() {}, start() {},
    },
  });
  const response = await request(runtime.info.port, {
    method: 'POST', path: '/api/record-deletions',
    headers: uiHeaders(runtime.info, `http://127.0.0.1:${runtime.info.port}`),
    body: JSON.stringify({ closed_pull_requests: [
      { owner: 'example', repo: 'first', number: 31 },
      { owner: 'example', repo: 'second', number: 31 },
    ] }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(jsonBody(response), { deleted: { sessions: 0, pullRequests: 2 } });
  assert.deepEqual(refreshAttempts, [['example', 'first'], ['example', 'second']]);
});

test('PR 登録に失敗したときは削除印を解除しない', async (t) => {
  const state = new DashboardState();
  const sessionId = 'deleted-registration';
  state.syncSessionFiles([{ session_id: sessionId }]);
  state.deleteSession(sessionId);
  state.registerPullRequest = () => null;
  const runtime = await runningServer(t, { state, findSessionIdByPid: async () => null });
  const response = await request(runtime.info.port, {
    method: 'POST', path: `/api/sessions/${sessionId}/prs`,
    headers: hookHeaders(runtime.info.secret),
    body: JSON.stringify({ kind: 'add_pr', ppid: 1, url: 'https://github.com/example/project/pull/31' }),
  });

  assert.equal(response.status, 400);
  assert.equal(state.deletedSessions.has(sessionId), true);
});

test('削除時刻以前のフックは回答待ちの再登録にも渡さない', async (t) => {
  const state = new DashboardState();
  const delivered = [];
  const runtime = await runningServer(t, {
    state,
    answerDelivery: { afterEvent: event => delivered.push(event), sessionEnded() {}, sessionReopened() {}, close() {} },
  });
  const deletedAt = Date.now();
  state.syncSessionFiles([{ session_id: 'old-hook' }], deletedAt - 1);
  state.deleteSession('old-hook', deletedAt);
  for (const hookAt of [deletedAt - 1, deletedAt, deletedAt + 1]) {
    const response = await request(runtime.info.port, {
      method: 'POST', path: '/api/events', headers: hookHeaders(runtime.info.secret),
      body: JSON.stringify({ session_id: 'old-hook', hook_event_name: 'SessionStart', hookAt }),
    });
    assert.equal(response.status, 202);
  }
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].hookAt, deletedAt + 1);
});

test('離席中の切り替えは秘密値と Origin を照合し、状態を軽い応答で返す', async (t) => {
  const runtime = await runningServer(t);
  const body = JSON.stringify({ enabled: true });
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const jsonContent = { 'content-type': 'application/json' };
  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body,
    headers: { ...jsonContent, origin },
  });
  assert.equal(missingSecret.status, 401);

  const hookSecret = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body,
    headers: hookHeaders(runtime.info.secret, jsonContent),
  });
  assert.equal(hookSecret.status, 401);

  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body,
    headers: uiHeaders(runtime.info, 'https://other.example', jsonContent),
  });
  assert.equal(foreignOrigin.status, 403);

  const enabled = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body,
    headers: uiHeaders(runtime.info, undefined, jsonContent),
  });
  assert.equal(enabled.status, 200);
  const enabledState = jsonBody(enabled);
  assert.equal(enabledState.enabled, true);
  assert.ok(Number.isFinite(enabledState.since));
  assert.deepEqual(enabledState.periods, [{ start: enabledState.since, end: null }]);

  const enabledLocalhost = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body,
    headers: {
      ...uiHeaders(runtime.info, `http://localhost:${runtime.info.port}`, jsonContent),
    },
  });
  assert.equal(enabledLocalhost.status, 200);

  const enabledLoopback = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body,
    headers: {
      ...uiHeaders(runtime.info, origin, jsonContent),
    },
  });
  assert.equal(enabledLoopback.status, 200);

  const disabled = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body: JSON.stringify({ enabled: false }),
    headers: {
      ...uiHeaders(runtime.info, `http://localhost:${runtime.info.port}`, jsonContent),
    },
  });
  assert.equal(disabled.status, 200);
  const disabledState = jsonBody(disabled);
  assert.equal(disabledState.enabled, false);
  assert.equal(disabledState.since, null);
  assert.equal(disabledState.periods.length, 1);
  assert.equal(disabledState.periods[0].start, enabledState.since);
  assert.ok(Number.isFinite(disabledState.periods[0].end));

  const invalidEnabled = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body: JSON.stringify({ enabled: 'true' }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(invalidEnabled.status, 400);

  const away = await request(runtime.info.port, { path: '/api/away' });
  assert.deepEqual(Object.keys(jsonBody(away)).sort(), ['enabled', 'periods', 'since']);
  assert.deepEqual(jsonBody(away), disabledState);
  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.deepEqual(state.away, disabledState);
  assert.equal(away.headers['access-control-allow-origin'], undefined);
});

test('PR マージ口は画面秘密値と Origin 必須照合を行い、owner/repo を要求本文から拒む', async (t) => {
  const runtime = await runningServer(t);
  const path = '/api/pull-requests/merge';
  const payload = {
    number: 41, registration_key: 'b'.repeat(64),
    headRefOid: 'a'.repeat(40), method: 'squash', deleteBranch: true,
  };
  const body = JSON.stringify(payload);
  const origin = `http://127.0.0.1:${runtime.info.port}`;

  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', origin },
  });
  assert.equal(missingSecret.status, 401);

  const hookSecret = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret, origin },
  });
  assert.equal(hookSecret.status, 401);

  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);

  const missingOrigin = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(missingOrigin.status, 403);

  const missingRegistrationKey = await request(runtime.info.port, {
    method: 'POST', path, body: JSON.stringify({ ...payload, registration_key: undefined }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin },
  });
  assert.equal(missingRegistrationKey.status, 400);

  const suppliedRepository = await request(runtime.info.port, {
    method: 'POST', path, body: JSON.stringify({ ...payload, owner: 'example', repo: 'project' }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin },
  });
  assert.equal(suppliedRepository.status, 400);

  const recordedKeyOnly = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin },
  });
  assert.equal(recordedKeyOnly.status, 404);
});

test('衝突解消依頼口は画面秘密値と Origin を照合する', async (t) => {
  const runtime = await runningServer(t);
  const path = '/api/pull-requests/conflict-request';
  const body = JSON.stringify({ key: 'c'.repeat(64), headRefOid: 'a'.repeat(40) });
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', origin },
  });
  assert.equal(missingSecret.status, 401);

  const wrongSecret = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret, origin },
  });
  assert.equal(wrongSecret.status, 401);

  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);

  const missingOrigin = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(missingOrigin.status, 403);
});

test('衝突解消依頼は PR と head と依頼先を取り直し、終了扱いでない登録セッションへ届ける', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_790_000_000_000 });
  const state = new DashboardState();
  const url = 'https://github.com/example/project/pull/42';
  const product = { product: { key: 'project', name: 'Project' } };
  for (const sessionId of ['request-active', 'request-ended', 'request-absent']) {
    state.registerPullRequest(sessionId, { url }, product, 1_790_000_000_000);
  }
  state.endSession('request-ended', 1_790_000_000_000);
  state.endSessionByAbsence('request-absent', 1_790_000_000_000);

  let pullRequest = {
    number: 42,
    url,
    headRefOid: 'a'.repeat(40),
    headRefName: 'feature/conflict',
    baseRefName: 'main',
    conflict: true,
  };
  const tracker = {
    start() {},
    close() {},
    async refreshRepoFresh() { return {}; },
    mergeCandidate() { return pullRequest ? { repository: { defaultBranch: 'main' }, pullRequest } : null; },
    snapshot() { return []; },
  };
  const notices = [];
  const runtime = await runningServer(t, {
    state,
    pullRequestTracker: tracker,
    answerDelivery: {
      notifySessions: (sessionIds, message) => { notices.push({ sessionIds, message }); return true; },
      close() {},
    },
    pullRequestMergeOptions: { now: () => 1_790_000_000_000 },
  });
  const registration = state.pullRequestRegistrationsForRepo('example', 'project')
    .find((record) => record.session_id === 'request-active');
  const key = state.pullRequestRegistrationKey(registration);
  const path = '/api/pull-requests/conflict-request';
  const headers = {
    'content-type': 'application/json',
    'x-cockpit-secret': runtime.info.uiSecret,
    origin: `http://127.0.0.1:${runtime.info.port}`,
  };
  const send = (requestKey = key, headRefOid = 'a'.repeat(40)) => request(runtime.info.port, {
    method: 'POST', path, body: JSON.stringify({ key: requestKey, headRefOid }), headers,
  });

  assert.equal((await send('f'.repeat(64))).status, 404);
  pullRequest = null;
  assert.equal((await send()).status, 404);
  pullRequest = { ...registration.lastOpen, number: 42, url, headRefOid: 'a'.repeat(40), headRefName: 'feature/conflict', baseRefName: 'main', conflict: false };
  assert.equal((await send()).status, 409);
  pullRequest.conflict = true;
  assert.equal((await send(key, 'b'.repeat(40))).status, 409);
  state.endSession('request-active', 1_790_000_000_000);
  assert.equal((await send()).status, 409);

  state.endedAt.delete('request-active');
  pullRequest.headRefOid = 'a'.repeat(40);
  const accepted = await send();
  assert.equal(accepted.status, 200);
  assert.deepEqual(notices.map((notice) => notice.sessionIds), [['request-active']]);
  assert.match(notices[0].message, /#42.*https:\/\/github\.com\/example\/project\/pull\/42/);
  assert.match(notices[0].message, /base ブランチ main を取り込んで衝突を解消し、検証してから push/);
  assert.match(notices[0].message, /マージしない/);
  assert.match(notices[0].message, /解消できない場合は、その理由を報告/);
  assert.deepEqual(state.pullRequestConflictRequest('example', 'project', 42), {
    owner: 'example', repo: 'project', number: 42, headRefOid: 'a'.repeat(40),
    requestedAt: new Date(1_790_000_000_000).toISOString(), sessionIds: ['request-active'],
  });
});

test('状態推定 API は画面の認証とセッション状態を照合し、結果を保存する', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const state = new DashboardState();
  const cwd = path.join(homeDir, 'workspace', 'project');
  state.syncSessionFiles([
    { session_id: 'estimate_unknown', cwd, name: '不明なセッション' },
    { session_id: 'estimate_known', cwd, name: '既知のセッション' },
  ]);
  state.addEvent({ session_id: 'estimate_known', hook_event_name: 'SessionStart', source: 'startup', hookAt: 100 });
  const projectDirectory = path.join(claudeHome, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, 'estimate_unknown.jsonl'), `${JSON.stringify({
    type: 'assistant', timestamp: '2026-10-02T01:02:03.000Z', isSidechain: false,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '本文は返さない' }] },
  })}\n`);
  const runtime = await startServer({ homeDir, claudeHome, port: 0, state });
  t.after(() => runtime.close());
  const endpoint = '/api/sessions/estimate_unknown/estimate';
  const validHeaders = {
    'content-type': 'application/json',
    'x-cockpit-secret': runtime.info.uiSecret,
    origin: `http://127.0.0.1:${runtime.info.port}`,
  };

  const unauthorized = await request(runtime.info.port, { method: 'POST', path: endpoint });
  assert.equal(unauthorized.status, 401);
  const forbidden = await request(runtime.info.port, {
    method: 'POST', path: endpoint,
    headers: { ...validHeaders, origin: 'https://other.example' },
  });
  assert.equal(forbidden.status, 403);
  const { origin: _estimateOrigin, ...withoutOrigin } = validHeaders;
  const originMissing = await request(runtime.info.port, { method: 'POST', path: endpoint, headers: withoutOrigin });
  assert.equal(originMissing.status, 403);
  const missing = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/not_known/estimate', headers: validHeaders,
  });
  assert.equal(missing.status, 404);
  const conflict = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/estimate_known/estimate', headers: validHeaders,
  });
  assert.equal(conflict.status, 409);

  const versionBeforeEstimate = state.version;
  const estimated = await request(runtime.info.port, { method: 'POST', path: endpoint, headers: validHeaders });
  assert.equal(estimated.status, 200);
  assert.equal(state.version, versionBeforeEstimate + 1);
  assert.deepEqual(jsonBody(estimated), {
    canEstimate: true, recordedAt: '2026-10-02T01:02:03.000Z', lastTool: null, state: 'input',
  });
  const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.deepEqual(snapshot.sessions.find((session) => session.session_id === 'estimate_unknown').estimate, jsonBody(estimated));
  assert.equal(snapshot.version, state.version);
});

test('一覧から外す API は認証し、複数の状態のセッションをまとめて外してすべて表示できる', async (t) => {
  const state = new DashboardState();
  state.syncSessionFiles([
    { session_id: 'hide_unknown', cwd: 'C:\\project', name: '不明なセッション' },
    { session_id: 'hide_known', cwd: 'C:\\project', name: '既知のセッション' },
  ]);
  state.addEvent({ session_id: 'hide_known', hook_event_name: 'SessionStart', hookAt: 100 });
  const runtime = await runningServer(t, { state });
  const endpoint = '/api/hidden-sessions';
  const body = JSON.stringify({ action: 'hide', session_id: 'hide_unknown' });
  const validHeaders = {
    'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret,
    origin: `http://127.0.0.1:${runtime.info.port}`,
  };

  const unauthorized = await request(runtime.info.port, { method: 'POST', path: endpoint, body });
  assert.equal(unauthorized.status, 401);
  const forbidden = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body,
    headers: { ...validHeaders, origin: 'https://other.example' },
  });
  assert.equal(forbidden.status, 403);
  const { origin: _hiddenOrigin, ...withoutOrigin } = validHeaders;
  const originMissing = await request(runtime.info.port, { method: 'POST', path: endpoint, body, headers: withoutOrigin });
  assert.equal(originMissing.status, 403);
  const missing = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'hide', session_id: 'not_known' }), headers: validHeaders,
  });
  assert.equal(missing.status, 404);
  const conflict = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'hide', session_id: 'hide_known' }), headers: validHeaders,
  });
  assert.equal(conflict.status, 200);
  assert.deepEqual(jsonBody(conflict), { hidden: true });
  const invalid = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'clear', session_id: 'extra' }), headers: validHeaders,
  });
  assert.equal(invalid.status, 400);

  const versionBeforeHide = state.version;
  const hidden = await request(runtime.info.port, { method: 'POST', path: endpoint, body, headers: validHeaders });
  assert.equal(hidden.status, 200);
  assert.equal(state.version, versionBeforeHide + 1);
  assert.deepEqual(jsonBody(hidden), { hidden: true });
  assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions.find((session) => session.session_id === 'hide_unknown').hidden, true);

  const batchHidden = await request(runtime.info.port, {
    method: 'POST', path: endpoint,
    body: JSON.stringify({ action: 'hide', session_ids: ['hide_unknown', 'hide_known', 'not_known'] }),
    headers: validHeaders,
  });
  assert.equal(batchHidden.status, 200);
  assert.deepEqual(jsonBody(batchHidden), { hidden: 2 });
  const allHidden = jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions;
  assert.equal(allHidden.find((session) => session.session_id === 'hide_unknown').hidden, true);
  assert.equal(allHidden.find((session) => session.session_id === 'hide_known').hidden, true);

  const batchMissing = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'hide', session_ids: ['not_known'] }), headers: validHeaders,
  });
  assert.equal(batchMissing.status, 404);
  const emptyBatch = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'hide', session_ids: [] }), headers: validHeaders,
  });
  assert.equal(emptyBatch.status, 400);
  const oversizedBatch = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'hide', session_ids: Array.from({ length: 51 }, (_, index) => `session_${index}`) }), headers: validHeaders,
  });
  assert.equal(oversizedBatch.status, 400);

  const versionBeforeClear = state.version;
  const cleared = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'clear' }), headers: validHeaders,
  });
  assert.equal(cleared.status, 200);
  assert.equal(state.version, versionBeforeClear + 1);
  assert.deepEqual(jsonBody(cleared), { cleared: 2 });
  assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions.find((session) => session.session_id === 'hide_unknown').hidden, undefined);
});

test('予約と予約取消の口は画面秘密値と Origin を照合する', async (t) => {
  const runtime = await runningServer(t);
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin };
  const reservationBody = JSON.stringify({ number: 41, registration_key: 'b'.repeat(64), headRefOid: 'a'.repeat(40), method: 'squash', deleteBranch: true });
  const cancellationBody = JSON.stringify({ number: 41, registration_key: 'b'.repeat(64) });

  for (const [path, body] of [
    ['/api/pull-requests/reserve', reservationBody],
    ['/api/pull-requests/cancel-reservation', cancellationBody],
  ]) {
    assert.equal((await request(runtime.info.port, { method: 'POST', path, body, headers: { 'content-type': 'application/json', origin } })).status, 401);
    assert.equal((await request(runtime.info.port, { method: 'POST', path, body, headers: { ...headers, origin: 'https://other.example' } })).status, 403);
    const { origin: _origin, ...withoutOrigin } = headers;
    assert.equal((await request(runtime.info.port, { method: 'POST', path, body, headers: withoutOrigin })).status, 403);
    assert.equal((await request(runtime.info.port, { method: 'POST', path, body, headers })).status, 404);
  }
});

test('一覧から外したセッションを指定して戻す API は認証し、0 件と入力不正を処理する', async (t) => {
  const state = new DashboardState();
  state.syncSessionFiles([
    { session_id: 'unhide_one', cwd: 'C:\\project', name: '戻すセッション' },
    { session_id: 'unhide_two', cwd: 'C:\\project', name: '残すセッション' },
  ]);
  state.hideSession('unhide_one');
  state.hideSession('unhide_two');
  const runtime = await runningServer(t, { state });
  const endpoint = '/api/hidden-sessions';
  const headers = {
    'content-type': 'application/json',
    'x-cockpit-secret': runtime.info.uiSecret,
    origin: `http://127.0.0.1:${runtime.info.port}`,
  };

  const unauthorized = await request(runtime.info.port, {
    method: 'POST', path: endpoint,
    body: JSON.stringify({ action: 'unhide', session_ids: ['unhide_one'] }),
    headers: { 'content-type': 'application/json', origin: headers.origin },
  });
  assert.equal(unauthorized.status, 401);

  const versionBeforeUnhide = state.version;
  const unhidden = await request(runtime.info.port, {
    method: 'POST', path: endpoint,
    body: JSON.stringify({ action: 'unhide', session_ids: ['unhide_one'] }), headers,
  });
  assert.equal(unhidden.status, 200);
  assert.deepEqual(jsonBody(unhidden), { unhidden: 1 });
  assert.equal(state.version, versionBeforeUnhide + 1);
  assert.equal(state.hiddenSessions.has('unhide_one'), false);
  assert.equal(state.hiddenSessionUpdatedAt.has('unhide_one'), false);
  assert.equal(state.hiddenSessions.has('unhide_two'), true);

  const versionBeforeNoop = state.version;
  const alreadyVisible = await request(runtime.info.port, {
    method: 'POST', path: endpoint,
    body: JSON.stringify({ action: 'unhide', session_ids: ['unhide_one'] }), headers,
  });
  assert.equal(alreadyVisible.status, 200);
  assert.deepEqual(jsonBody(alreadyVisible), { unhidden: 0 });
  assert.equal(state.version, versionBeforeNoop);

  for (const invalidBody of [
    { action: 'unhide', session_ids: [] },
    { action: 'unhide', session_ids: ['bad id'] },
    { action: 'unhide', session_ids: Array.from({ length: 51 }, (_, index) => `session_${index}`) },
    { action: 'unhide', session_id: 'unhide_one' },
    { action: 'unhide', session_ids: ['unhide_one'], extra: true },
  ]) {
    const invalid = await request(runtime.info.port, {
      method: 'POST', path: endpoint, body: JSON.stringify(invalidBody), headers,
    });
    assert.equal(invalid.status, 400);
  }
});

test('セッションファイルを読めない環境でも、読み込みの猶予を過ぎた期限切れの記録は走査のたびに片付ける', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const now = Date.now();
  const state = new DashboardState({ homeDir });
  state.setTasks('expired-session', [{ title: '期限切れ', state: 'todo', criteria: [] }], now - 20 * 24 * 60 * 60 * 1000);
  state.restoreSessionCleanupPending = true;
  state.restoredAt = now - 11 * 60 * 1000;

  const runtime = await startServer({ homeDir, claudeHome, port: 0, state });
  t.after(() => runtime.close());

  assert.equal(state.plans.has('expired-session'), false);
});

test('離席状態は同じ置き場でサーバーを再起動しても残る', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const first = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => first.close());
  const enabled = await request(first.info.port, {
    method: 'POST', path: '/api/away', body: JSON.stringify({ enabled: true }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': first.info.uiSecret },
  });
  assert.equal(enabled.status, 200);
  const saved = jsonBody(enabled);
  assert.equal(JSON.parse(await fs.readFile(path.join(homeDir, 'away.json'), 'utf8')).since, saved.since);
  assert.deepEqual(saved.periods, [{ start: saved.since, end: null }]);
  await first.close();

  const second = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => second.close());
  assert.deepEqual(jsonBody(await request(second.info.port, { path: '/api/away' })), saved);
  assert.deepEqual(jsonBody(await request(second.info.port, { path: '/api/state' })).away, saved);
});

test('経路設定 API は画面秘密値と必須 Origin を照合し、保存値をスナップショットに返す', async (t) => {
  const runtime = await runningServer(t);
  const endpoint = '/api/routing';
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const body = JSON.stringify({ key: 'agents', value: 'claude' });
  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin };

  assert.deepEqual(jsonBody(await request(runtime.info.port, { path: '/api/state' })).routing, {
    agents: 'default', review: 'default',
  });
  assert.equal((await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { 'content-type': 'application/json', origin },
  })).status, 401);
  assert.equal((await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret, origin },
  })).status, 401);
  assert.equal((await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { ...headers, origin: 'https://other.example' },
  })).status, 403);
  assert.equal((await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  })).status, 403);
  assert.equal((await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ key: 'agents', value: 'unknown' }), headers,
  })).status, 400);

  const saved = await request(runtime.info.port, { method: 'POST', path: endpoint, body, headers });
  assert.equal(saved.status, 200);
  assert.deepEqual(jsonBody(saved), { agents: 'claude', review: 'default' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtime.homeDir, 'routing.json'), 'utf8')), jsonBody(saved));
  assert.deepEqual(jsonBody(await request(runtime.info.port, { path: '/api/state' })).routing, jsonBody(saved));
});

test('外部リンク API は画面秘密値と Origin を照合し、HTTPS の URL だけを開く', async (t) => {
  const openedUrls = [];
  let failOpen = false;
  const runtime = await runningServer(t, {
    openExternalUrl: async (url) => {
      openedUrls.push(url);
      if (failOpen) throw new Error('open failed');
    },
  });
  const endpoint = '/api/open-url';
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin };
  const send = (url, requestHeaders = headers) => request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ url }), headers: requestHeaders,
  });

  assert.equal((await send('https://github.com/acme/widget/pull/42', { 'content-type': 'application/json', origin })).status, 401);
  assert.equal((await send('https://github.com/acme/widget/pull/42', { ...headers, origin: 'https://other.example' })).status, 403);

  for (const url of [
    'http://example.com',
    `http://127.0.0.1:${runtime.info.port + 1}/manual/`,
    `http://example.com:${runtime.info.port}/manual/`,
    `http://127.0.0.1:${runtime.info.port}/settings`,
    `http://127.0.0.1:${runtime.info.port}/manuality/`,
    `http://127.0.0.1:${runtime.info.port}/manual`,
    `http://127.0.0.1:${runtime.info.port}/manual/`,
    `http://localhost:${runtime.info.port}/manual/pages/settings.html?from=dashboard#help-settings`,
    'javascript:alert(1)',
    'https://example.com/with\ncontrol',
    `https://example.com/${'a'.repeat(2048)}`,
  ]) {
    assert.equal((await send(url)).status, 400, url.slice(0, 40));
  }
  assert.deepEqual(openedUrls, []);

  const url = 'https://github.com/acme/widget/pull/42';
  const opened = await send(url);
  assert.equal(opened.status, 204);
  assert.equal(opened.body, '');
  assert.deepEqual(openedUrls, [url]);

  failOpen = true;
  assert.equal((await send(url)).status, 500);
  assert.deepEqual(openedUrls, [url, url]);
  failOpen = false;

  // 起動するプログラムへは、検査した正規化後の値だけを渡す。
  openedUrls.length = 0;
  for (const raw of [' https://github.com/a', 'https://example.com/a b', 'https://example.com/?q=" & x', 'https:\\\\example.com\\a']) {
    assert.equal((await send(raw)).status, 204, raw);
  }
  assert.deepEqual(openedUrls, [
    'https://github.com/a',
    'https://example.com/a%20b',
    'https://example.com/?q=%22%20&%20x',
    'https://example.com/a',
  ]);
  assert.ok(openedUrls.every((opened) => !/[\s"\\]/.test(opened)));
});

test('壊れた離席状態は離席中ではない状態として読む', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  await fs.writeFile(path.join(homeDir, 'away.json'), '{invalid');
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());
  assert.deepEqual(jsonBody(await request(runtime.info.port, { path: '/api/away' })), {
    enabled: false, since: null, periods: [],
  });
});

test('画面には画面用の秘密値だけを埋め、iframe への埋め込みを拒み、/api/events は画面用の秘密値を受け付けない', async (t) => {
  const runtime = await runningServer(t);
  const page = await request(runtime.info.port, { path: '/' });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(`<meta name="cockpit-secret" content="${runtime.info.uiSecret}">`));
  assert.ok(!page.body.includes(runtime.info.secret));
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.equal(page.headers['access-control-allow-origin'], undefined);

  const event = await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body: JSON.stringify({}),
    headers: {
      'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret,
      origin: `http://127.0.0.1:${runtime.info.port}`,
    },
  });
  assert.equal(event.status, 403);

  const eventWithUiSecret = await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body: JSON.stringify({}),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(eventWithUiSecret.status, 401);
});

test('HTML 属性値のエスケープは一般の文字列に対応する', () => {
  assert.equal(escapeHtmlAttribute(`&"'<>`), '&amp;&quot;&#39;&lt;&gt;');
});

test('画面の版は配信した HTML と状態 API で一致し、ファイル更新後に変わる', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const webPath = path.join(homeDir, 'dashboard.html');
  const runtime = await startServer({ homeDir, claudeHome, port: 0, webPath });
  t.after(() => runtime.close());

  assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).uiVersion, null);

  const initialHtml = '<!doctype html><meta name="cockpit-secret" content=""><meta name="cockpit-ui-version" content="">';
  await fs.writeFile(webPath, initialHtml);
  const firstPage = await request(runtime.info.port, { path: '/' });
  const firstVersion = firstPage.body.match(/<meta name="cockpit-ui-version" content="([a-f0-9]{16})">/)?.[1];
  assert.ok(firstVersion);
  assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).uiVersion, firstVersion);

  const updatedHtml = `${initialHtml}\n<!-- updated -->`;
  await fs.writeFile(webPath, updatedHtml);
  const updatedVersion = crypto.createHash('sha256').update(updatedHtml).digest('hex').slice(0, 16);
  assert.notEqual(updatedVersion, firstVersion);
  const updatedState = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const updatedPage = await request(runtime.info.port, { path: '/' });
  const servedUpdatedVersion = updatedPage.body.match(/<meta name="cockpit-ui-version" content="([a-f0-9]{16})">/)?.[1];
  assert.equal(updatedState.uiVersion, updatedVersion);
  assert.equal(servedUpdatedVersion, updatedVersion);

  await fs.unlink(webPath);
  assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).uiVersion, updatedVersion);
});

async function runningServer(t, options = {}) {
  const server = await startTestServer(t, {
    temporaryPrefix: 'agent-cockpit-test-',
    environment: { AGENT_COCKPIT_HOME: (homeDir) => homeDir },
    ...options,
  });
  assert.equal(server.runtime.server.address().address, '127.0.0.1');
  return server.runtime;
}

test('常駐サーバーの Host は state と POST の要求でも照合する', async (t) => {
  const runtime = await runningServer(t);
  const host = `example.test:${runtime.info.port}`;
  const state = await request(runtime.info.port, { path: '/api/state', headers: { host } });
  assert.equal(state.status, 400);

  const posted = await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body: JSON.stringify({}),
    headers: { host, 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(posted.status, 400);
});

test('すべての POST 口で秘密値、Origin、Sec-Fetch-Site を照合する', async (t) => {
  const runtime = await runningServer(t);
  const endpoints = [
    { path: '/api/hooks/answers', secret: 'hook', originRequired: false },
    { path: '/api/decisions/decision-1/answer', secret: 'ui', originRequired: true },
    { path: '/api/pull-requests/review-skip', secret: 'ui', originRequired: true },
    { path: '/api/pull-requests/merge', secret: 'ui', originRequired: true },
    { path: '/api/pull-requests/reserve', secret: 'ui', originRequired: true },
    { path: '/api/pull-requests/cancel-reservation', secret: 'ui', originRequired: true },
    { path: '/api/pull-requests/conflict-request', secret: 'ui', originRequired: true },
    { path: '/api/sessions/session-a/estimate', secret: 'ui', originRequired: true },
    { path: '/api/record-deletions', secret: 'ui', originRequired: true },
    { path: '/api/hidden-sessions', secret: 'ui', originRequired: true },
    { path: '/api/display', secret: 'ui', originRequired: true },
    { path: '/api/pull-requests/merge-result/close', secret: 'ui', originRequired: true },
    { path: '/api/seen', secret: 'ui', originRequired: true },
    { path: '/api/closed-tasks', secret: 'ui', originRequired: true },
    { path: '/api/closed-agents', secret: 'ui', originRequired: true },
    { path: '/api/away', secret: 'ui', originRequired: false },
    { path: '/api/routing', secret: 'ui', originRequired: true },
    { path: '/api/open-url', secret: 'ui', originRequired: true },
    { path: '/api/update/check', secret: 'ui', originRequired: true },
    { path: '/api/events', secret: 'hook', originRequired: false },
    { path: '/api/sessions/session-a/plan', secret: 'hook', originRequired: false },
    { path: '/api/sessions/session-a/prs', secret: 'hook', originRequired: false },
  ];
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const secretFor = (kind) => kind === 'hook' ? runtime.info.secret : runtime.info.uiSecret;
  const write = (endpoint, headers = {}) => request(runtime.info.port, {
    method: 'POST', path: endpoint.path, body: '{}',
    headers: { 'content-type': 'application/json', ...headers },
  });

  for (const endpoint of endpoints) {
    const label = endpoint.path;
    const missingSecret = await write(endpoint);
    assert.equal(missingSecret.status, 401, `${label}: secretなし`);

    const otherSecret = endpoint.secret === 'hook' ? runtime.info.uiSecret : runtime.info.secret;
    const wrongSecret = await write(endpoint, { 'x-cockpit-secret': otherSecret });
    assert.equal(wrongSecret.status, 401, `${label}: 別の秘密値`);

    const foreignOrigin = await write(endpoint, {
      'x-cockpit-secret': secretFor(endpoint.secret), origin: 'https://other.example',
    });
    assert.equal(foreignOrigin.status, 403, `${label}: 他の Origin`);

    if (endpoint.originRequired) {
      const missingOrigin = await write(endpoint, { 'x-cockpit-secret': secretFor(endpoint.secret) });
      assert.equal(missingOrigin.status, 403, `${label}: Originなし`);
    }

    const crossSite = await write(endpoint, {
      'x-cockpit-secret': secretFor(endpoint.secret),
      ...(endpoint.secret === 'ui' ? { origin } : {}),
      'sec-fetch-site': 'cross-site',
    });
    assert.equal(crossSite.status, 403, `${label}: cross-site`);
  }
});

test('不在終了と再開を注入された回答配信へ通知する', async (t) => {
  const state = new DashboardState();
  const ended = [];
  const reopened = [];
  const answerDelivery = {
    sessionEnded: (sessionId, endedAt) => ended.push([sessionId, endedAt]),
    sessionReopened: (sessionId) => reopened.push(sessionId),
    close() {},
  };
  const runtime = await runningServer(t, { state, answerDelivery });
  const sessionId = 'server-injected-delivery';
  const file = { session_id: sessionId, cwd: 'C:\\project', name: '同期対象' };
  state.syncSessionFiles([file], 1_000);
  state.addEvent({ session_id: sessionId, hook_event_name: 'SessionStart', hookAt: 1_000 });
  state.syncSessionFiles([], 61_000);
  state.syncSessionFiles([file], 61_001);

  assert.deepEqual(ended, [[sessionId, 61_000]]);
  assert.deepEqual(reopened, [sessionId]);
});

test('/api/state は Claude のホームにある codex-agent.sh の有無を返す', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const scriptPath = path.join(claudeHome, 'tools', 'codex-agent.sh');
  const runtime = await startServer({
    homeDir,
    claudeHome,
    userHome: homeDir,
    port: 0,
    codexAgentScriptExists: async (filePath) => {
      assert.equal(filePath, scriptPath);
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
  });
  t.after(() => runtime.close());

  assert.deepEqual(jsonBody(await request(runtime.info.port, { path: '/api/state' })).integrations, { codexAgent: false, crossReview: false });
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, '');
  assert.deepEqual(jsonBody(await request(runtime.info.port, { path: '/api/state' })).integrations, { codexAgent: true, crossReview: false });
});

test('/api/state は CLAUDE_CONFIG_DIR が別の場所でも ~/.claude にある codex-agent.sh を検出する', async (t) => {
  const { homeDir } = await temporaryHome(t);
  const claudeHome = path.join(homeDir, 'custom-claude-home');
  const userHome = path.join(homeDir, 'user');
  const fallbackScript = path.join(userHome, '.claude', 'tools', 'codex-agent.sh');
  const inspected = [];
  const runtime = await startServer({
    homeDir,
    claudeHome,
    userHome,
    port: 0,
    codexAgentScriptExists: async (filePath) => {
      inspected.push(filePath);
      return filePath === fallbackScript;
    },
  });
  t.after(() => runtime.close());

  assert.deepEqual(jsonBody(await request(runtime.info.port, { path: '/api/state' })).integrations, { codexAgent: true, crossReview: false });
  assert.deepEqual(inspected, [path.join(claudeHome, 'tools', 'codex-agent.sh'), fallbackScript]);
});

test('/api/state は稼働中と PR 登録の worktree にあるクロスレビューの道具を検出する', async (t) => {
  const runtime = await runningServer(t);
  const activeRoot = path.join(runtime.homeDir, 'active-worktree');
  const registeredRoot = path.join(runtime.homeDir, 'registered-worktree');
  const activeTool = path.join(activeRoot, 'tools', 'cross-review.js');
  const registeredTool = path.join(registeredRoot, 'tools', 'cross-review.js');

  const integrations = async () => jsonBody(await request(runtime.info.port, { path: '/api/state' })).integrations;
  assert.deepEqual(await integrations(), { codexAgent: false, crossReview: false });

  await fs.mkdir(path.join(activeRoot, '.git'), { recursive: true });
  await fs.mkdir(path.dirname(activeTool), { recursive: true });
  await fs.writeFile(activeTool, '');
  runtime.state.syncSessionFiles([{ session_id: 'live-cross-review', cwd: path.join(activeRoot, 'src') }]);
  assert.deepEqual(await integrations(), { codexAgent: false, crossReview: true });

  runtime.state.syncSessionFiles([]);
  assert.deepEqual(await integrations(), { codexAgent: false, crossReview: false });

  await fs.mkdir(path.join(registeredRoot, '.git'), { recursive: true });
  await fs.mkdir(path.dirname(registeredTool), { recursive: true });
  await fs.writeFile(registeredTool, '');
  runtime.state.registerPullRequest('registered-cross-review', {
    url: 'https://github.com/example/project/pull/99',
  }, { cwd: path.join(registeredRoot, 'src') });
  assert.deepEqual(await integrations(), { codexAgent: false, crossReview: true });

  await fs.unlink(registeredTool);
  assert.deepEqual(await integrations(), { codexAgent: false, crossReview: false });
});

test('/api/state のクロスレビュー判定を差し替え、両方の cwd を調べる', async (t) => {
  const inspectedCwds = [];
  const runtime = await runningServer(t, {
    crossReviewToolExists: async (cwd) => {
      inspectedCwds.push(cwd);
      return cwd.endsWith('registered-worktree');
    },
  });
  const activeCwd = path.join(runtime.homeDir, 'active-worktree');
  const registeredCwd = path.join(runtime.homeDir, 'registered-worktree');
  runtime.state.syncSessionFiles([
    { session_id: 'live-one', cwd: activeCwd },
    { session_id: 'live-two', cwd: activeCwd },
    { session_id: 'live-no-cwd', cwd: 12 },
  ]);
  runtime.state.registerPullRequest('registered-one', {
    url: 'https://github.com/example/project/pull/100',
  }, { cwd: registeredCwd });

  assert.deepEqual(jsonBody(await request(runtime.info.port, { path: '/api/state' })).integrations, {
    codexAgent: false,
    crossReview: true,
  });
  assert.deepEqual(inspectedCwds, [activeCwd, registeredCwd]);
});

test('Agent 起動後の PostToolBatch はタスク催促を返し、タスク登録後は返さない', async (t) => {
  const runtime = await runningServer(t);
  const sessionId = 'task-nudge-integration';
  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret };
  const eventResponse = await request(runtime.info.port, {
    method: 'POST', path: '/api/events',
    body: JSON.stringify({
      session_id: sessionId, hook_event_name: 'PreToolUse', hookAt: Date.now(), tool_name: 'Agent',
    }),
    headers,
  });
  assert.equal(eventResponse.status, 202);

  const postToolBatch = () => request(runtime.info.port, {
    method: 'POST', path: '/api/hooks/answers',
    body: JSON.stringify({
      action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: sessionId, id: 'batch-1',
    }),
    headers,
  });
  const reminded = jsonBody(await postToolBatch());
  assert.match(reminded.hookOutput.hookSpecificOutput.additionalContext, /タスクが登録されていない/);

  const planResponse = await request(runtime.info.port, {
    method: 'POST', path: `/api/sessions/${sessionId}/plan`,
    body: JSON.stringify({ kind: 'tasks', tasks: [{ title: '検証する', state: 'doing', criteria: [] }] }),
    headers,
  });
  assert.equal(planResponse.status, 200);
  const afterTaskWrite = jsonBody(await postToolBatch());
  assert.equal(afterTaskWrite.hookOutput, null);
});

test('Host、秘密値、Origin を照合して書き込みを制限する', async (t) => {
  const runtime = await runningServer(t);
  const localhost = await request(runtime.info.port, { path: '/health', headers: { host: `localhost:${runtime.info.port}` } });
  assert.equal(localhost.status, 200);
  const invalidHost = await request(runtime.info.port, { path: '/health', headers: { host: `example.test:${runtime.info.port}` } });
  assert.equal(invalidHost.status, 400);

  const body = JSON.stringify({ session_id: 'secure', hook_event_name: 'SessionStart', hookAt: Date.now() });
  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(missingSecret.status, 401);

  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);

  const accepted = await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(accepted.status, 202);

  const devDisabled = await request(runtime.info.port, { path: '/api/dev/fields' });
  assert.equal(devDisabled.status, 404);
});

test('SubagentStart の経路をサブエージェントのスナップショットに記録する', () => {
  const state = new DashboardState();
  state.addEvent({
    session_id: 'route-record', hook_event_name: 'SubagentStart', hookAt: 100,
    agent_id: 'agent-1', agent_type: 'impl-hard', route: 'claude',
  });
  assert.equal(state.snapshot().sessions[0].agents[0].route, 'claude');
});

test('SubagentStart のない agent_type 付きイベントから定義を読み込んで行を復元する', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const agentsDirectory = path.join(claudeHome, 'agents');
  await fs.mkdir(agentsDirectory, { recursive: true });
  await fs.writeFile(path.join(agentsDirectory, 'Explore.md'), '---\nmodel: claude-sonnet-5-5\neffort: high\n---\n');
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());

  const response = await request(runtime.info.port, {
    method: 'POST', path: '/api/events',
    body: JSON.stringify({
      session_id: 'restored-agent', hook_event_name: 'PreToolUse', hookAt: 200,
      agent_id: 'agent-1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'read-1', summary: 'README.md',
    }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(response.status, 202);

  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const [agent] = state.sessions.find((session) => session.session_id === 'restored-agent').agents;
  assert.equal(agent.model, 'claude-sonnet-5-5');
  assert.equal(agent.effort, 'high');
});

test('サブエージェント行があるイベントでは定義を読み直さず SubagentStart では読む', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const definitionPath = path.join(claudeHome, 'agents', 'Explore.md');
  await fs.mkdir(path.dirname(definitionPath), { recursive: true });
  await fs.writeFile(definitionPath, '---\nmodel: claude-sonnet-5-5\n---\n');
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());

  const originalReadFile = fs.readFile;
  let definitionReads = 0;
  fs.readFile = async function (filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(definitionPath)) definitionReads += 1;
    return originalReadFile.call(fs, filePath, ...args);
  };
  try {
    const postEvent = (hook_event_name, hookAt, tool_use_id) => request(runtime.info.port, {
      method: 'POST', path: '/api/events',
      body: JSON.stringify({
        session_id: 'agent-definition-read', hook_event_name, hookAt,
        agent_id: 'agent-1', agent_type: 'Explore', tool_name: 'Read', tool_use_id,
      }),
      headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
    });

    assert.equal((await postEvent('PreToolUse', 100, 'read-1')).status, 202);
    assert.equal(definitionReads, 1);
    assert.equal((await postEvent('PreToolUse', 200, 'read-2')).status, 202);
    assert.equal(definitionReads, 1);
    assert.equal((await postEvent('SubagentStart', 300, 'read-3')).status, 202);
    assert.equal(definitionReads, 2);
  } finally {
    fs.readFile = originalReadFile;
  }
});

test('再起動後の Codex --wait は実行 ID の定義からモデルと effort を読む', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const definitionPath = path.join(claudeHome, 'gpt-agents', 'impl-hard.md');
  await fs.mkdir(path.dirname(definitionPath), { recursive: true });
  await fs.writeFile(definitionPath, '---\ncodex_model: gpt-5.5-codex\ncodex_reasoning_effort: xhigh\n---\n');
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());

  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret };
  const waitId = 'impl-hard-20261003-123456-7';
  const waiting = await request(runtime.info.port, {
    method: 'POST', path: '/api/events',
    body: JSON.stringify({
      session_id: 'wait-definition', hook_event_name: 'PreToolUse', hookAt: 100,
      agent_id: 'agent-1', agent_type: 'impl-hard', tool_name: 'Bash', tool_use_id: 'wait-1',
      summary: `bash ~/.claude/tools/codex-agent.sh --wait ${waitId}`, codexWaitRunId: waitId,
    }),
    headers,
  });
  assert.equal(waiting.status, 202);

  const completed = await request(runtime.info.port, {
    method: 'POST', path: '/api/events',
    body: JSON.stringify({
      session_id: 'wait-definition', hook_event_name: 'PostToolUse', hookAt: 200,
      agent_id: 'agent-1', tool_name: 'Bash', tool_use_id: 'wait-1',
      codexOutput: { resultLine: 'codex-agent: result=ok' },
    }),
    headers,
  });
  assert.equal(completed.status, 202);

  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const [agent] = state.sessions.find((session) => session.session_id === 'wait-definition').agents;
  assert.deepEqual([agent.gpt.model, agent.gpt.effort, agent.gpt.active], ['gpt-5.5-codex', 'xhigh', false]);
});

test('クロスレビュー定義から Codex の仮モデルを読み、未許可の定義名は行を作らない', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const definitionPath = path.join(claudeHome, 'gpt-agents', 'codex-review.md');
  await fs.mkdir(path.dirname(definitionPath), { recursive: true });
  await fs.writeFile(definitionPath, '---\ncodex_model: gpt-review-definition\ncodex_reasoning_effort: high\n---\n');
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());

  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret };
  const started = await request(runtime.info.port, {
    method: 'POST', path: '/api/events',
    body: JSON.stringify({
      session_id: 'review-definition', hook_event_name: 'PreToolUse', hookAt: 100,
      tool_name: 'Bash', tool_use_id: 'review-1',
      summary: `cd "${'D:/long/worktree/path/'.repeat(8)}repo" && npm run review:codex`,
      codexReviewDefinition: 'codex-review',
    }),
    headers,
  });
  assert.equal(started.status, 202);

  const initialState = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const [initialAgent] = initialState.sessions.find((session) => session.session_id === 'review-definition').agents;
  assert.deepEqual([initialAgent.agent_type, initialAgent.model, initialAgent.effort, initialAgent.active], [
    'codex-review', 'gpt-review-definition', 'high', true,
  ]);

  const completed = await request(runtime.info.port, {
    method: 'POST', path: '/api/events',
    body: JSON.stringify({
      session_id: 'review-definition', hook_event_name: 'PostToolUse', hookAt: 200,
      tool_name: 'Bash', tool_use_id: 'review-1',
      codexOutput: {
        auditLine: 'codex-agent: agent=codex-review model=gpt-review-actual effort=xhigh sandbox=read-only',
        resultLine: 'codex-agent: result=ok',
      },
    }),
    headers,
  });
  assert.equal(completed.status, 202);

  const rejected = await request(runtime.info.port, {
    method: 'POST', path: '/api/events',
    body: JSON.stringify({
      session_id: 'review-invalid-definition', hook_event_name: 'PreToolUse', hookAt: 300,
      tool_name: 'Bash', tool_use_id: 'review-invalid', summary: 'npm run review:codex',
      codexReviewDefinition: 'untrusted-definition',
    }),
    headers,
  });
  assert.equal(rejected.status, 202);

  const finalState = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const [agent] = finalState.sessions.find((session) => session.session_id === 'review-definition').agents;
  assert.deepEqual([agent.model, agent.effort, agent.active], ['gpt-review-actual', 'xhigh', false]);
  assert.deepEqual(finalState.sessions.find((session) => session.session_id === 'review-invalid-definition').agents, []);
});

test('/plan は秘密値と Origin を照合し、session ID と入力上限を検査する', async (t) => {
  const runtime = await runningServer(t);
  const path = '/api/sessions/plan-session/plan';
  const body = JSON.stringify({ kind: 'tasks', tasks: [] });
  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(missingSecret.status, 401);

  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: {
      'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret,
      origin: `http://127.0.0.1:${runtime.info.port}`,
    },
  });
  assert.equal(foreignOrigin.status, 403);

  const invalidSession = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/bad_session/plan', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(invalidSession.status, 400);

  const tooManyTasks = await request(runtime.info.port, {
    method: 'POST', path, body: JSON.stringify({ kind: 'tasks', tasks: Array.from({ length: 51 }, (_, index) => ({ title: `task ${index}`, state: 'todo', criteria: [] })) }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(tooManyTasks.status, 400);
});

test('/prs は秘密値と Origin を照合し、MCP とフックから PR を登録する', async (t) => {
  const calls = { repos: [], all: 0 };
  const pullRequestTracker = {
    start() {},
    close() {},
    snapshot: () => [],
    refreshRepo(owner, repo) { calls.repos.push(`${owner}/${repo}`); return Promise.resolve(); },
    refreshAll() { calls.all += 1; return Promise.resolve(); },
  };
  const runtime = await runningServer(t, {
    pullRequestTracker,
    findSessionIdByPid: async () => null,
  });
  const body = JSON.stringify({
    kind: 'add_pr', url: 'https://github.com/example/project/pull/46',
    ppid: 123, claudeCodeSessionId: 'pr-session', cwd: process.cwd(),
  });
  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/pr-session/prs', body,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(missingSecret.status, 401);
  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/pr-session/prs', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);
  const added = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/pr-session/prs', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(added.status, 200);
  assert.deepEqual(jsonBody(added), {
    owner: 'example', repo: 'project', number: 46,
    url: 'https://github.com/example/project/pull/46',
  });
  assert.equal(runtime.state.pullRequestRegistrations()[0].number, 46);

  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret };
  const hookCwd = path.join(runtime.homeDir, 'session-project', '.claude', 'worktrees', 'session');
  const commandCwd = path.join(runtime.homeDir, 'pull-request-project', '.claude', 'worktrees', 'feature');
  const createCommand = `cd "${commandCwd.replaceAll('\\', '/')}" && gh pr create --fill`;
  await request(runtime.info.port, {
    method: 'POST', path: '/api/events', headers,
    body: JSON.stringify({
      session_id: 'pr-session', hook_event_name: 'PreToolUse', hookAt: Date.now(),
      cwd: hookCwd, tool_name: 'Bash', tool_use_id: 'create-47', ghPrCreateCommand: true,
    }),
  });
  const postCreateEvent = makeHookEvent({
    session_id: 'pr-session', hook_event_name: 'PostToolUse', cwd: hookCwd,
    tool_name: 'Bash', tool_use_id: 'create-47', tool_input: { command: createCommand },
    tool_response: { stdout: 'https://github.com/example/project/pull/47' },
  });
  await request(runtime.info.port, {
    method: 'POST', path: '/api/events', headers,
    body: JSON.stringify(postCreateEvent),
  });
  const registeredPr = runtime.state.pullRequestRegistrations().find((record) => record.number === 47);
  assert.ok(registeredPr);
  assert.equal(registeredPr.cwd, path.resolve(commandCwd));
  assert.equal(registeredPr.product.key, productFromCwd(commandCwd).key);
  assert.equal(registeredPr.product.name, productFromCwd(commandCwd).name);
  assert.notEqual(registeredPr.product.key, productFromCwd(hookCwd).key);

  await request(runtime.info.port, {
    method: 'POST', path: '/api/events', headers,
    body: JSON.stringify({
      session_id: 'pr-session', hook_event_name: 'PostToolUse', hookAt: Date.now(),
      tool_name: 'Bash', tool_use_id: 'unrelated',
      pullRequest: { owner: 'example', repo: 'project', number: 48, url: 'https://github.com/example/project/pull/48' },
    }),
  });
  assert.ok(!runtime.state.pullRequestRegistrations().some((record) => record.number === 48));

  // フックが cd 先から決めた cwd と製品は、同じ PR を /prs で登録し直しても変えない。
  const reregistered = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/pr-session/prs', headers,
    body: JSON.stringify({
      kind: 'add_pr', url: 'https://github.com/example/project/pull/47',
      ppid: 123, claudeCodeSessionId: 'pr-session', cwd: hookCwd,
    }),
  });
  assert.equal(reregistered.status, 200);
  const keptPr = runtime.state.pullRequestRegistrations().find((record) => record.number === 47);
  assert.equal(keptPr.cwd, path.resolve(commandCwd));
  assert.equal(keptPr.product.key, productFromCwd(commandCwd).key);

  // 未登録の PR は、/prs の cwd で登録される。
  const addedWithoutHook = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/pr-session/prs', headers,
    body: JSON.stringify({
      kind: 'add_pr', url: 'https://github.com/example/project/pull/49',
      ppid: 123, claudeCodeSessionId: 'pr-session', cwd: hookCwd,
    }),
  });
  assert.equal(addedWithoutHook.status, 200);
  const registeredByPrs = runtime.state.pullRequestRegistrations().find((record) => record.number === 49);
  assert.equal(registeredByPrs.cwd, hookCwd);
  assert.equal(registeredByPrs.product.key, productFromCwd(hookCwd).key);

  await request(runtime.info.port, {
    method: 'POST', path: '/api/events', headers,
    body: JSON.stringify({
      session_id: 'pr-session', hook_event_name: 'PreToolUse', hookAt: Date.now(),
      tool_name: 'Bash', tool_use_id: 'push-1', refreshPullRequestsCommand: true,
    }),
  });
  await request(runtime.info.port, {
    method: 'POST', path: '/api/events', headers,
    body: JSON.stringify({
      session_id: 'pr-session', hook_event_name: 'PostToolUse', hookAt: Date.now(),
      tool_name: 'Bash', tool_use_id: 'push-1',
    }),
  });
  assert.equal(calls.all, 2);
  assert.ok(calls.repos.includes('example/project'));
  const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.deepEqual(snapshot.pullRequests, []);
});

test('レビュー不要は画面から設定と取消ができ、MCP は秘密値と現在の head を照合する', async (t) => {
  let headRefOid = 'a'.repeat(40);
  const pullRequestTracker = {
    start() {},
    close() {},
    snapshot: () => [],
    async refreshRepoFresh() { return {}; },
    mergeCandidate() { return { pullRequest: { headRefOid } }; },
    async refreshReviewGroups() {},
  };
  const runtime = await runningServer(t, {
    pullRequestTracker,
    findSessionIdByPid: async () => null,
  });
  runtime.state.registerPullRequest('review-session', {
    url: 'https://github.com/example/project/pull/49',
  }, { cwd: process.cwd(), product: { key: 'project', name: 'project' } });
  const registration = runtime.state.pullRequestRegistrations()[0];
  const registrationKey = runtime.state.pullRequestRegistrationKey(registration);
  const screenPath = '/api/pull-requests/review-skip';
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const screenHeaders = {
    'content-type': 'application/json',
    'x-cockpit-secret': runtime.info.uiSecret,
    origin,
  };
  const screenBody = (action) => JSON.stringify({ action, headRefOid, registration_key: registrationKey });

  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path: screenPath, body: screenBody('set'),
    headers: { 'content-type': 'application/json', origin },
  });
  assert.equal(missingSecret.status, 401);
  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path: screenPath, body: screenBody('set'),
    headers: { ...screenHeaders, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);

  const setFromScreen = await request(runtime.info.port, {
    method: 'POST', path: screenPath, body: screenBody('set'), headers: screenHeaders,
  });
  assert.equal(setFromScreen.status, 200);
  assert.equal(runtime.state.crossReviewSkip('example', 'project', 49).headRefOid, headRefOid);
  const clearFromScreen = await request(runtime.info.port, {
    method: 'POST', path: screenPath, body: screenBody('clear'), headers: screenHeaders,
  });
  assert.equal(clearFromScreen.status, 200);
  assert.equal(runtime.state.crossReviewSkip('example', 'project', 49), null);

  const mcpBody = JSON.stringify({
    kind: 'skip_review', owner: 'example', repo: 'project', number: 49, headRefOid,
    reason: 'この差分は設定ファイルの空白だけのため', ppid: 321, claudeCodeSessionId: 'review-session',
  });
  const mcpPath = '/api/sessions/review-session/prs';
  const mcpWrite = await request(runtime.info.port, {
    method: 'POST', path: mcpPath, body: mcpBody,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(mcpWrite.status, 200);
  assert.equal(jsonBody(mcpWrite).reason, 'この差分は設定ファイルの空白だけのため');
  assert.equal(runtime.state.crossReviewSkip('example', 'project', 49).headRefOid, headRefOid);

  headRefOid = 'b'.repeat(40);
  const staleHead = await request(runtime.info.port, {
    method: 'POST', path: mcpPath, body: mcpBody,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(staleHead.status, 409);
});

test('/plan はタスクと判断事項を記録し、読み取り用の要約を返す', async (t) => {
  const runtime = await runningServer(t);
  const path = '/api/sessions/plan-session/plan';
  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret };
  const tasksResponse = await request(runtime.info.port, {
    method: 'POST', path,
    body: JSON.stringify({
      kind: 'tasks',
      tasks: [{ title: 'API を追加する', state: 'doing', criteria: [{ text: '一覧に出る', met: true }] }],
    }),
    headers,
  });
  assert.equal(tasksResponse.status, 200);
  assert.deepEqual(jsonBody(tasksResponse).tasks, [{ title: 'API を追加する', state: 'doing' }]);

  const added = await request(runtime.info.port, {
    method: 'POST', path,
    body: JSON.stringify({
      kind: 'add_decision', title: '状態を選ぶ', context: '運用上の理由を記録する。', state: 'waiting',
      options: [{ label: '(推奨) waiting', description: '利用者の確認を待つ。', recommended: true }],
    }),
    headers,
  });
  assert.equal(added.status, 200);
  const decision = jsonBody(added).decision;
  assert.ok(decision.id);
  assert.deepEqual([decision.title, decision.state], ['状態を選ぶ', 'waiting']);

  const updated = await request(runtime.info.port, {
    method: 'POST', path,
    body: JSON.stringify({ kind: 'update_decision', id: decision.id, state: 'provisional', chosen: 'waiting', note: '確認後に進める。' }),
    headers,
  });
  assert.equal(updated.status, 200);
  assert.equal(jsonBody(updated).decision.state, 'provisional');

  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const session = state.sessions.find((item) => item.session_id === 'plan-session');
  runtime.state.syncSessionFiles([{ session_id: 'plan-session', cwd: 'C:\\project', name: '計画中' }]);
  const stateWithSessionFile = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const visibleSession = stateWithSessionFile.sessions.find((item) => item.session_id === 'plan-session');
  assert.equal(session, undefined);
  assert.deepEqual(visibleSession.tasks, [{ title: 'API を追加する', state: 'doing', criteria: [{ text: '一覧に出る', met: true }] }]);
  assert.deepEqual(visibleSession.decisions[0].resolution, { chosen: 'waiting', note: '確認後に進める。' });
  assert.equal(visibleSession.decisions[0].answer, null);

  const context = jsonBody(await request(runtime.info.port, { path: '/api/sessions/plan-session/context' }));
  assert.deepEqual(context.tasks, [{ title: 'API を追加する', state: 'doing' }]);
  assert.deepEqual(context.decisions, [{ id: decision.id, title: '状態を選ぶ', state: 'provisional' }]);
});

test('/plan は同じ題を持つタスク一覧を拒む', async (t) => {
  const runtime = await runningServer(t);
  const response = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/duplicate-tasks/plan',
    body: JSON.stringify({
      kind: 'tasks',
      tasks: [taskForRequest('同じ題'), taskForRequest('同じ題', 'todo')],
    }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(response.status, 400);
});

function taskForRequest(title, state = 'doing') {
  return { title, state, criteria: [] };
}

test('表示設定 API は照合し、変更した項目だけを既存値へ合わせる', async (t) => {
  const runtime = await runningServer(t);
  const endpoint = '/api/display';
  const body = JSON.stringify({ mode: 'kind' });
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const validHeaders = {
    'content-type': 'application/json',
    'x-cockpit-secret': runtime.info.uiSecret,
    origin,
  };

  assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).display, null);
  const unauthorized = await request(runtime.info.port, { method: 'POST', path: endpoint, body, headers: { 'content-type': 'application/json', origin } });
  assert.equal(unauthorized.status, 401);
  const forbidden = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { ...validHeaders, origin: 'https://other.example' },
  });
  assert.equal(forbidden.status, 403);
  const missingOrigin = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(missingOrigin.status, 403);
  const invalid = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ mode: 'kind', display: { hidden: [] } }), headers: validHeaders,
  });
  assert.equal(invalid.status, 400);

  const mode = await request(runtime.info.port, { method: 'POST', path: endpoint, body, headers: validHeaders });
  assert.equal(mode.status, 200);
  assert.equal(jsonBody(mode).display.longWaitMinutes, 15);
  assert.deepEqual(jsonBody(mode).display.sectionOrder, ['sinceSeen', 'judgment', 'prs', 'tasks', 'now']);
  assert.equal(jsonBody(mode).display.awayAnswerWaitMinutes, 3);
  assert.equal(jsonBody(mode).display.idleHideMinutes, 10);
  assert.equal(jsonBody(mode).display.hideFinished, true);
  assert.equal(jsonBody(mode).display.mergeableCondition, 'cross-review');
  assert.equal(Object.hasOwn(jsonBody(mode).display, 'mergeAfterReviewDefault'), false);
  const hidden = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ hidden: ['agents', 'prs'] }), headers: validHeaders,
  });
  assert.equal(hidden.status, 200);
  const pinned = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ pinned: ['C:\\project'] }), headers: validHeaders,
  });
  assert.equal(pinned.status, 200);
  for (const sectionOrder of [
    ['tasks', 'unknown'],
    ['tasks', 'tasks'],
    'tasks',
  ]) {
    const invalidOrder = await request(runtime.info.port, {
      method: 'POST', path: endpoint, body: JSON.stringify({ sectionOrder }), headers: validHeaders,
    });
    assert.equal(invalidOrder.status, 400);
  }
  for (const [key, invalidValue] of [
    ['longWaitMinutes', 0], ['longWaitMinutes', 121], ['longWaitMinutes', 1.5], ['longWaitMinutes', '15'],
    ['awayAnswerWaitMinutes', 0], ['awayAnswerWaitMinutes', 31], ['awayAnswerWaitMinutes', 2.5], ['awayAnswerWaitMinutes', null],
    ['idleHideMinutes', 4], ['idleHideMinutes', 1441], ['idleHideMinutes', 30.5], ['idleHideMinutes', '30'], ['idleHideMinutes', null],
    ['hideFinished', 1], ['hideFinished', 'true'], ['hideFinished', null],
    ['mergeableCondition', 'unknown'], ['mergeableCondition', null],
    ['mergeAfterReviewDefault', true],
  ]) {
    const invalidMinutes = await request(runtime.info.port, {
      method: 'POST', path: endpoint, body: JSON.stringify({ [key]: invalidValue }), headers: validHeaders,
    });
    assert.equal(invalidMinutes.status, 400, `${key}: ${invalidValue}`);
  }
  const sectionOrder = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ sectionOrder: ['tasks'] }), headers: validHeaders,
  });
  assert.equal(sectionOrder.status, 200);
  assert.deepEqual(jsonBody(sectionOrder).display.sectionOrder, ['tasks', 'sinceSeen', 'judgment', 'prs', 'now']);
  for (const idleHideMinutes of [5, 1440]) {
    const idleHideRange = await request(runtime.info.port, {
      method: 'POST', path: endpoint, body: JSON.stringify({ idleHideMinutes }), headers: validHeaders,
    });
    assert.equal(idleHideRange.status, 200);
    assert.equal(jsonBody(idleHideRange).display.idleHideMinutes, idleHideMinutes);
  }
  const minimumWaitSettings = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ longWaitMinutes: 1, awayAnswerWaitMinutes: 1 }), headers: validHeaders,
  });
  assert.equal(minimumWaitSettings.status, 200);
  const waitSettings = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ longWaitMinutes: 120, awayAnswerWaitMinutes: 30 }), headers: validHeaders,
  });
  assert.equal(waitSettings.status, 200);
  assert.equal(jsonBody(waitSettings).display.longWaitMinutes, 120);
  assert.equal(jsonBody(waitSettings).display.awayAnswerWaitMinutes, 30);
  assert.equal(runtime.answerDelivery.answerWaitMs(), 30 * 60_000);
  const hideFinished = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ hideFinished: true }), headers: validHeaders,
  });
  assert.equal(hideFinished.status, 200);
  assert.equal(jsonBody(hideFinished).display.hideFinished, true);
  for (const mergeableCondition of ['operation', 'ci', 'cross-review']) {
    const selected = await request(runtime.info.port, {
      method: 'POST', path: endpoint, body: JSON.stringify({ mergeableCondition }), headers: validHeaders,
    });
    assert.equal(selected.status, 200);
    assert.equal(jsonBody(selected).display.mergeableCondition, mergeableCondition);
  }
  const removedPreference = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ mergeAfterReviewDefault: true }), headers: validHeaders,
  });
  assert.equal(removedPreference.status, 400);
  assert.deepEqual(jsonBody(await request(runtime.info.port, { path: '/api/state' })).display, {
    mode: 'kind', order: [], pinned: ['C:\\project'], collapsed: [], hidden: ['agents', 'prs'],
    sectionOrder: ['tasks', 'sinceSeen', 'judgment', 'prs', 'now'],
    longWaitMinutes: 120, awayAnswerWaitMinutes: 30, idleHideMinutes: 1440, hideFinished: true, mergeableCondition: 'cross-review', diagnosticsLevel: 'info',
  });
});

test('予約マージ結果を閉じる API は秘密値と Origin を照合して閉鎖を保存する', async (t) => {
  const runtime = await runningServer(t);
  const endpoint = '/api/pull-requests/merge-result/close';
  const payload = { owner: 'example', repo: 'project', number: 41 };
  const body = JSON.stringify(payload);
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin };

  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { 'content-type': 'application/json', origin },
  });
  assert.equal(missingSecret.status, 401);
  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { ...headers, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);
  const missingOrigin = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(missingOrigin.status, 403);
  const invalid = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ ...payload, number: 0 }), headers,
  });
  assert.equal(invalid.status, 400);

  runtime.state.recordMergedPullRequest({
    ...payload, title: '予約結果', url: 'https://github.com/example/project/pull/41',
    mergedAt: new Date().toISOString(), method: 'squash', automatic: true,
    automaticResult: { branchDeleted: false, autoDeleteBranch: false, retargetedBase: null, retargetedNumbers: [], warning: null },
  });
  const closed = await request(runtime.info.port, { method: 'POST', path: endpoint, body, headers });
  assert.equal(closed.status, 200);
  assert.equal(jsonBody(closed).closed, true);
  const record = runtime.state.mergedPullRequestHistoryForRepo('example', 'project')[0];
  assert.ok(Number.isFinite(Date.parse(record.mergeResultClosedAt)));
  const repeated = await request(runtime.info.port, { method: 'POST', path: endpoint, body, headers });
  assert.equal(repeated.status, 200);
  assert.equal(jsonBody(repeated).closed, true);
});

test('既読 API は秘密値と Origin を照合し、初回表示後の変化と新しい判断を返す', async (t) => {
  const state = new DashboardState();
  const sessionId = 'seen-session';
  const product = { key: 'C:\\seen-project', name: 'seen-project' };
  state.syncSessionFiles([{ session_id: sessionId, cwd: product.key, name: '既読の確認', product }]);
  state.setTasks(sessionId, [{ title: '表示前の完了', state: 'done', criteria: [] }]);
  state.addDecision(sessionId, {
    title: '表示前の判断', context: '', state: 'waiting',
    options: [{ label: '案 A', description: '', recommended: true }],
  });
  const runtime = await runningServer(t, { state });
  const endpoint = '/api/seen';
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const validHeaders = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin };

  const firstView = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.deepEqual(firstView.sinceSeen, []);
  assert.equal(firstView.sessions[0].decisions[0].isNew, false);
  assert.equal(state.seenAtByProduct.has(product.key), true);
  await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body: JSON.stringify({ enabled: true }), headers: validHeaders,
  });
  const afterView = Date.now();
  state.setTasks(sessionId, [
    { title: '表示前の完了', state: 'done', criteria: [] },
    { title: '表示後・既読前の完了', state: 'done', criteria: [] },
  ], afterView);
  const body = JSON.stringify({ productKey: product.key, generatedAt: firstView.generatedAt });

  assert.equal((await request(runtime.info.port, { method: 'POST', path: endpoint, body, headers: { 'content-type': 'application/json', origin } })).status, 401);
  assert.equal((await request(runtime.info.port, {
    method: 'POST', path: endpoint, body,
    headers: { ...validHeaders, 'x-cockpit-secret': runtime.info.secret },
  })).status, 401);
  assert.equal((await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { ...validHeaders, origin: 'https://other.example' },
  })).status, 403);
  assert.equal((await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  })).status, 403);
  assert.equal((await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ productKey: '' }), headers: validHeaders,
  })).status, 400);
  assert.equal((await request(runtime.info.port, {
    method: 'POST', path: endpoint,
    body: JSON.stringify({ productKey: product.key, generatedAt: 'not-a-time' }), headers: validHeaders,
  })).status, 400);
  assert.equal((await request(runtime.info.port, {
    method: 'POST', path: endpoint,
    body: JSON.stringify({ productKey: product.key, generatedAt: new Date(Date.now() + 1000).toISOString() }), headers: validHeaders,
  })).status, 400);
  const seen = await request(runtime.info.port, { method: 'POST', path: endpoint, body, headers: validHeaders });
  assert.equal(seen.status, 200);
  assert.equal(jsonBody(seen).seenAt, firstView.generatedAt);

  const future = Math.max(Date.now(), afterView);
  state.setTasks(sessionId, [
    { title: '表示前の完了', state: 'done', criteria: [] },
    { title: '表示後・既読前の完了', state: 'done', criteria: [] },
    { title: '既読後の完了', state: 'done', criteria: [] },
  ], future);
  const decision = state.addDecision(sessionId, {
    title: '既読後の判断', context: '', state: 'waiting',
    options: [{ label: '案 B', description: '', recommended: true }],
  }, future);

  const nextView = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const visibleSession = nextView.sessions.find((session) => session.session_id === sessionId);
  assert.equal(visibleSession.decisions.find((item) => item.id === decision.id).isNew, true);
  assert.equal(visibleSession.decisions.find((item) => item.title === '表示前の判断').isNew, false);
  assert.deepEqual(nextView.sinceSeen[0].items.map((item) => item.text), [
    'タスク「既読後の完了」が完了した',
    'タスク「表示後・既読前の完了」が完了した',
  ]);
});

test('画面からタスクと終了可能なエージェントを終了にできる', async (t) => {
  const state = new DashboardState();
  const runtime = await runningServer(t, { state });
  const sessionId = 'close-actions';
  state.syncSessionFiles([{ session_id: sessionId, cwd: 'C:\\project', name: '閉じる操作' }]);
  state.setTasks(sessionId, [{ title: '完了にする', state: 'doing', criteria: [] }]);
  state.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'agent-1', agent_type: 'impl-hard' });
  state.addEvent({
    session_id: sessionId, hook_event_name: 'PreToolUse', hookAt: 2, agent_id: 'agent-1',
    tool_name: 'Bash', tool_use_id: 'bash-1', summary: 'bash ~/.claude/tools/codex-agent.sh impl-hard < prompt.md',
  });
  state.addEvent({ session_id: sessionId, hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'agent-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStop', hookAt: 4, agent_id: 'agent-1' });

  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin };
  const taskBody = JSON.stringify({ session_id: sessionId, title: '完了にする' });
  const missingOrigin = await request(runtime.info.port, {
    method: 'POST', path: '/api/closed-tasks', body: taskBody,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(missingOrigin.status, 403);
  const missingSecret = await request(runtime.info.port, { method: 'POST', path: '/api/closed-tasks', body: taskBody, headers: { 'content-type': 'application/json', origin } });
  assert.equal(missingSecret.status, 401);
  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path: '/api/closed-tasks', body: taskBody, headers: { ...headers, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);
  const closedTask = await request(runtime.info.port, { method: 'POST', path: '/api/closed-tasks', body: taskBody, headers });
  assert.equal(closedTask.status, 200);
  assert.equal(state.snapshot().sessions[0].tasks[0].state, 'done');
  assert.equal(state.snapshot().sessions[0].tasks[0].closedByUser, true);

  const closeAgent = await request(runtime.info.port, {
    method: 'POST', path: '/api/closed-agents',
    body: JSON.stringify({ session_id: sessionId, agent_id: 'agent-1' }), headers,
  });
  assert.equal(closeAgent.status, 200);
  assert.equal(state.snapshot().sessions[0].agents[0].unconfirmed, false);
  state.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStart', hookAt: 5, agent_id: 'agent-1', agent_type: 'impl-hard' });
  assert.equal(state.closedAgents.has(sessionId), false);
  assert.equal(state.snapshot().sessions[0].agents[0].active, true);

  const rootSessionId = 'close-root-codex';
  state.addEvent({
    session_id: rootSessionId, hook_event_name: 'PreToolUse', hookAt: 1,
    tool_name: 'Bash', tool_use_id: 'bash-root', summary: 'bash ~/.claude/tools/codex-agent.sh impl-hard < prompt.md',
  });
  state.addEvent({ session_id: rootSessionId, hook_event_name: 'PostToolUse', hookAt: 2, tool_name: 'Bash', tool_use_id: 'bash-root' });
  state.addEvent({ session_id: rootSessionId, hook_event_name: 'Stop', hookAt: 3 });
  const rootAgent = state.snapshot().sessions.find((session) => session.session_id === rootSessionId).agents[0];
  assert.equal(rootAgent.closable, true);

  const closeRootAgent = await request(runtime.info.port, {
    method: 'POST', path: '/api/closed-agents',
    body: JSON.stringify({ session_id: rootSessionId, agent_id: rootAgent.agent_id }), headers,
  });
  assert.equal(closeRootAgent.status, 200);
  const closedRootSession = state.snapshot().sessions.find((session) => session.session_id === rootSessionId);
  const closedRootAgent = closedRootSession.agents[0];
  assert.deepEqual([closedRootAgent.active, closedRootAgent.unconfirmed, closedRootAgent.closable], [false, false, undefined]);
  assert.equal(closedRootSession.status, '待機中');
});

test('/plan は ppid に一致するセッションファイルの ID を優先する', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const sessionDirectory = path.join(claudeHome, 'sessions');
  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(path.join(sessionDirectory, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: 'pid-session', name: 'PID から解決したセッション',
  }));
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());
  const response = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/fallback-session/plan',
    body: JSON.stringify({
      kind: 'tasks', tasks: [{ title: 'PID のセッションに保存', state: 'todo', criteria: [] }],
      ppid: process.pid, claudeCodeSessionId: 'fallback-session',
    }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(response.status, 200);
  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const pidSession = state.sessions.find((session) => session.session_id === 'pid-session');
  assert.deepEqual(pidSession.tasks.map(({ title }) => title), ['PID のセッションに保存']);
  assert.ok(!state.sessions.some((session) => session.session_id === 'fallback-session'));
});

test('64 KB を超える本文を拒否する', async (t) => {
  const runtime = await runningServer(t);
  const response = await request(runtime.info.port, {
    method: 'POST', path: '/api/events',
    body: 'x'.repeat(MAX_BODY_BYTES + 1),
    headers: {
      'content-type': 'application/json',
      'x-cockpit-secret': runtime.info.secret,
    },
  });
  assert.equal(response.status, 413);
});

test('server.json は待ち受け成功後にだけ書く', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  let listeningResolve;
  const listening = new Promise((resolve) => { listeningResolve = resolve; });
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const starting = startServer({
    homeDir,
    claudeHome,
    port: 0,
    afterListen: async (server) => {
      assert.equal(server.listening, true);
      await assert.rejects(fs.access(path.join(homeDir, 'server.json')));
      listeningResolve();
      await writeGate;
    },
  });
  await listening;
  releaseWrite();
  const runtime = await starting;
  t.after(() => runtime.close());
  assert.equal(JSON.parse(await fs.readFile(path.join(homeDir, 'server.json'), 'utf8')).port, runtime.info.port);
});

test('EADDRINUSE で負けた同時起動は server.json に触れない', async (t) => {
  const runtime = await runningServer(t);
  const serverInfoPath = path.join(runtime.homeDir, 'server.json');
  const before = await fs.readFile(serverInfoPath, 'utf8');
  const losingServer = new EventEmitter();
  losingServer.listening = false;
  losingServer.listen = () => {
    queueMicrotask(() => losingServer.emit('error', Object.assign(new Error('address already in use'), { code: 'EADDRINUSE' })));
  };
  losingServer.close = (callback) => callback?.();

  await assert.rejects(
    startServer({ homeDir: runtime.homeDir, claudeHome: path.join(runtime.homeDir, '.claude'), port: 0, server: losingServer }),
    (error) => error.code === 'EADDRINUSE',
  );
  assert.equal(await fs.readFile(serverInfoPath, 'utf8'), before);
});

test('開発用フィールド口は --dev のときだけ使える', async (t) => {
  const runtime = await runningServer(t, { dev: true });
  const event = JSON.stringify({
    session_id: 'dev-session', hook_event_name: 'Notification', cwd: 'D:\\repo',
    notification_type: 'permission_prompt', message: '許可待ち', secret_input: 'must-not-be-recorded',
    input_fields: ['session_id', 'hook_event_name', 'notification_type', 'message'],
  });
  await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body: event,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  const fields = jsonBody(await request(runtime.info.port, { path: '/api/dev/fields' }));
  assert.ok(fields.fields.includes('Notification.notification_type'));
  assert.deepEqual(fields.notificationTypes, ['permission_prompt']);
  assert.ok(!JSON.stringify(fields).includes('must-not-be-recorded'));
});

test('SessionStart はタイトルを読み、ダッシュボードの URL を返す', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const sessionId = 'session-title';
  const sessionDirectory = path.join(claudeHome, 'sessions');
  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(path.join(sessionDirectory, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, name: '段階 1 の実装' }));
  await fs.writeFile(path.join(sessionDirectory, `${sessionId}.key`), 'not a session record');
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());

  const result = await runHook({
    session_id: sessionId,
    hook_event_name: 'SessionStart',
    cwd: 'D:\\Desktop\\Develop\\agent-cockpit\\.claude\\worktrees\\stage1',
  }, { homeDir, environment: { AGENT_COCKPIT_HOME: homeDir } });

  assert.equal(result.exitCode, 0);
  assert.equal(result.additionalContext, `Agent Cockpit: http://127.0.0.1:${runtime.info.port}/`);
  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.equal(state.sessions[0].title, '段階 1 の実装');
  // cwd が実在するリポジトリの下を指すので、ブランチ名は実行する場所で変わる。比べる対象から外す。
  const { branch: _branch, ...product } = state.sessions[0].product;
  assert.deepEqual(product, { key: 'd:\\desktop\\develop\\agent-cockpit', name: 'agent-cockpit' });
});

test('起動時に、フックがまだ届いていない生きているセッションを一覧に出す', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const sessionDirectory = path.join(claudeHome, 'sessions');
  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(path.join(sessionDirectory, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: 'waiting-session', name: '待機しているセッション', cwd: 'D:\\work\\repo',
  }));
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());
  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.deepEqual(
    state.sessions.map((session) => [session.session_id, session.title, session.status, session.product.name]),
    [['waiting-session', '待機しているセッション', '不明', 'repo']],
  );
});

test('離席状態の切り替えを続けて呼ぶと、呼んだ順に保存される', async (t) => {
  const { homeDir } = await temporaryHome(t);
  const { AwayState } = require('../src/server/state');
  const away = await AwayState.load(homeDir);
  const results = await Promise.all([away.setEnabled(true), away.setEnabled(false), away.setEnabled(true)]);
  assert.deepEqual(results.map((value) => value.enabled), [true, false, true]);
  assert.equal(away.snapshot().enabled, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(homeDir, 'away.json'), 'utf8')).enabled, true);
});

test('/api/state は版と時刻を、離席期間の整理を待つ前に中身と同じ時点で確定する', async () => {
  const source = (await fs.readFile(path.join(__dirname, '../src/server/routes/read.js'), 'utf8')).replace(/\r\n/g, '\n');
  const start = source.indexOf('async function handleState(');
  const handler = source.slice(start, source.indexOf('jsonResponse(response, 200', start));
  const versionAt = handler.indexOf('snapshot.version = state.version;');
  const pruneAt = handler.indexOf('away.prune?.(');
  assert.ok(versionAt > 0 && pruneAt > versionAt);
  assert.doesNotMatch(handler, /await away\.prune/);
});

test('Claude のセッションのフォルダーが無いときは、セッションのファイルが無いと判定して自動終了を妨げない', async (t) => {
  const { claudeHome } = createTemporaryHome(t);
  assert.equal(await hasSessionJsonFiles(claudeHome), false);
  await fs.mkdir(path.join(claudeHome, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(claudeHome, 'sessions', '1.json'), '{}');
  assert.equal(await hasSessionJsonFiles(claudeHome), true);
});

test('Claude のセッションのフォルダーを読めないときは、セッションがあるものとして自動終了しない', async (t) => {
  const { claudeHome } = createTemporaryHome(t);
  await fs.mkdir(claudeHome, { recursive: true });
  await fs.writeFile(path.join(claudeHome, 'sessions'), 'not a directory');
  assert.equal(await hasSessionJsonFiles(claudeHome), true);
});
