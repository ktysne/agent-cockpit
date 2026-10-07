'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { jsonBody, request, startTestServer } = require('./support/server');
const { createRegistrationFixture } = require('./support/registration');

function sessionFile(pid, sessionId, procStart = `start-${pid}`) {
  return { session_id: sessionId, pid, procStart, cwd: '', name: null, updatedAt: null };
}

function fakeListing(initial) {
  const listing = { files: initial, calls: 0 };
  listing.list = async () => {
    listing.calls += 1;
    return listing.files.map((file) => ({ ...file }));
  };
  return listing;
}

async function startLineageServer(t, listing, extra = {}) {
  return startTestServer(t, {
    temporaryPrefix: 'agent-cockpit-claude-lineage-',
    sessionScanIntervalMs: 20,
    listSessionFiles: listing.list,
    ...extra,
  });
}

function post(server, requestPath, body) {
  return request(server.info.port, {
    method: 'POST',
    path: requestPath,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': server.info.secret },
  });
}

function hookEvent(sessionId, fields = {}) {
  return { session_id: sessionId, hook_event_name: 'UserPromptSubmit', cwd: process.cwd(), hookAt: Date.now(), ...fields };
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

test('claudeLineage が通ると、フックの要求はフック用 writer の経路で処理される', async (t) => {
  const server = await startLineageServer(t, fakeListing([sessionFile(100, 'session-a')]));

  const accepted = await post(server, '/api/events', { ...hookEvent('session-a'), claudeLineage: { ppid: 100 } });

  assert.equal(accepted.status, 202);
  assert.ok(server.runtime.state.snapshot().sessions.some((session) => session.session_id === 'session-a'));
  const log = await post(server, '/api/events', { ...hookEvent('session-a') });
  assert.equal(log.status, 403, 'lineage を持たない要求は、登録済みの session_id を従来どおり拒否する');
});

test('claudeLineage を持たない要求は、未登録の session_id に限り従来の観測の経路で扱う', async (t) => {
  const server = await startLineageServer(t, fakeListing([]));

  const observed = await post(server, '/api/events', hookEvent('observed-only'));

  assert.equal(observed.status, 202);
  assert.ok(server.runtime.state.snapshot().sessions.some((session) => session.session_id === 'observed-only'));
});

test('claudeLineage と writer を同時に送る要求は 403 で拒否する', async (t) => {
  const server = await startLineageServer(t, fakeListing([sessionFile(100, 'session-a')]));
  const writer = { token: 'x'.repeat(43), identity: {}, contextId: 'claude-hooks', executionId: 'exec-1' };

  const both = await post(server, '/api/events', { ...hookEvent('session-a'), writer, claudeLineage: { ppid: 100 } });
  assert.equal(both.status, 403);
  assert.equal(jsonBody(both).reason, 'claude_writer_conflict');
  const bothAnswer = await post(server, '/api/hooks/answers', {
    action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: 'session-a', id: 'id-1', writer, claudeLineage: { ppid: 100 },
  });
  assert.equal(bothAnswer.status, 403);
  assert.equal(server.runtime.state.isSessionAbsenceProtected('session-a'), false);
});

test('照合に失敗したフックは、未登録の session_id なら観測として受け付け、期間を登録しない', async (t) => {
  const server = await startLineageServer(t, fakeListing([sessionFile(100, 'session-a')]));
  const failures = [
    { claudeLineage: {} },
    { claudeLineage: { ppid: '100' } },
    { claudeLineage: { ppid: 0 } },
    { claudeLineage: { ppid: 1.5 } },
    { claudeLineage: { ppid: 100, extra: true } },
    { claudeLineage: [100] },
    { claudeLineage: null },
    { claudeLineage: 'x' },
    { claudeLineage: { ppid: 999 } },
    { claudeLineage: { ppid: 100 }, mismatch: true },
  ];
  for (const [index, failure] of failures.entries()) {
    const sessionId = `observed-${index}`;
    const { mismatch: _mismatch, ...lineage } = failure;
    const observed = await post(server, '/api/events', { ...hookEvent(sessionId), ...lineage });
    assert.equal(observed.status, 202, JSON.stringify(failure));
    assert.ok(server.runtime.state.snapshot().sessions.some((session) => session.session_id === sessionId), sessionId);
    assert.equal(server.runtime.state.isSessionAbsenceProtected(sessionId), false, sessionId);
  }
  // 親の Claude のセッション ID と違う sessionId を名乗っても、親の期間は登録されない。
  assert.equal(server.runtime.state.isSessionAbsenceProtected('session-a'), false);
  const log = await fs.readFile(path.join(server.homeDir, 'server.log'), 'utf8');
  assert.match(log, /claude writer rejected: source=hook reason=claude_parent_unverified/);
  assert.match(log, /claude writer rejected: source=hook reason=claude_session_mismatch/);
});

test('照合に失敗したフックは、登録済みの session_id には書けず、状態を変えない', async (t) => {
  const server = await startLineageServer(t, fakeListing([sessionFile(100, 'session-a')]));
  assert.equal((await post(server, '/api/events', { ...hookEvent('session-a'), claudeLineage: { ppid: 100 } })).status, 202);
  assert.equal(server.runtime.state.isSessionAbsenceProtected('session-a'), true);
  const before = JSON.stringify(server.runtime.state.snapshot().sessions.find((session) => session.session_id === 'session-a'));

  for (const lineage of [{ ppid: 999 }, { ppid: '100' }, {}, undefined]) {
    const rejected = await post(server, '/api/events', {
      ...hookEvent('session-a', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'forged', tool_input: { command: 'ls' } }),
      ...(lineage === undefined ? {} : { claudeLineage: lineage }),
    });
    assert.equal(rejected.status, 403, JSON.stringify(lineage));
  }

  assert.equal(JSON.stringify(server.runtime.state.snapshot().sessions.find((session) => session.session_id === 'session-a')), before);
});

test('回答のフックも、照合に失敗したら未登録の session_id だけ従来の経路で扱い、登録済みの session_id は拒否する', async (t) => {
  const server = await startLineageServer(t, fakeListing([sessionFile(100, 'session-a')]));
  const body = { action: 'post-tool-batch', event_name: 'PostToolBatch', id: 'id-1' };

  const unregistered = await post(server, '/api/hooks/answers', { ...body, session_id: 'session-b', claudeLineage: { ppid: 100 } });
  assert.equal(unregistered.status, 200);
  const accepted = await post(server, '/api/hooks/answers', { ...body, session_id: 'session-a', claudeLineage: { ppid: 100 } });
  assert.equal(accepted.status, 200);
  assert.equal(server.runtime.state.isSessionAbsenceProtected('session-a'), true);

  for (const lineage of [{ ppid: 999 }, {}, undefined]) {
    const rejected = await post(server, '/api/hooks/answers', {
      ...body, session_id: 'session-a', ...(lineage === undefined ? {} : { claudeLineage: lineage }),
    });
    assert.equal(rejected.status, 403, JSON.stringify(lineage));
  }
});

test('再開した期間は表示用の sessionId が実行 ID になり、フックの要求はその ID へ振り替える', async (t) => {
  const listing = fakeListing([sessionFile(100, 'session-a', 'start-1')]);
  const server = await startLineageServer(t, listing);
  assert.equal((await post(server, '/api/events', { ...hookEvent('session-a'), claudeLineage: { ppid: 100 } })).status, 202);
  assert.equal(server.runtime.state.isSessionAbsenceProtected('session-a'), true);

  listing.files = [];
  await waitFor(() => !server.runtime.state.isSessionAbsenceProtected('session-a'), 'first period to end');
  listing.files = [sessionFile(300, 'session-a', 'start-3')];
  const resumed = await post(server, '/api/events', { ...hookEvent('session-a'), claudeLineage: { ppid: 300 } });

  assert.equal(resumed.status, 202);
  const ids = server.runtime.state.snapshot().sessions.map((session) => session.session_id);
  const resumedId = ids.find((id) => id.startsWith('exec-'));
  assert.ok(resumedId, JSON.stringify(ids));
  assert.equal(server.runtime.state.isSessionAbsenceProtected(resumedId), true);
  assert.equal(server.runtime.state.isSessionAbsenceProtected('session-a'), false);
});

test('registry を注入した構成には issuer が無く、claudeLineage は使わずに従来の経路で扱う', async (t) => {
  const fixture = createRegistrationFixture('claude', { nativeId: 'injected-session' });
  const server = await startTestServer(t, { registrationRegistry: fixture.registry });

  const writer = await post(server, '/api/claude/writer', { ppid: 100, contextPid: 1 });
  assert.equal(writer.status, 503);
  const observed = await post(server, '/api/events', { ...hookEvent('unregistered-session'), claudeLineage: { ppid: 100 } });
  assert.equal(observed.status, 202);
  const registered = await post(server, '/api/events', { ...hookEvent('injected-session'), claudeLineage: { ppid: 100 } });
  assert.equal(registered.status, 403, '登録済みの session_id は writer が無ければ拒否する');
  assert.equal(server.runtime.state.isSessionAbsenceProtected('injected-session'), true);
});

test('期間が終わった Claude のセッションは、不在の判定で終了扱いになる', async (t) => {
  const listing = fakeListing([sessionFile(100, 'session-a')]);
  const server = await startLineageServer(t, listing);
  await post(server, '/api/events', { ...hookEvent('session-a'), claudeLineage: { ppid: 100 } });
  await waitFor(() => server.runtime.state.sessionFileLastSeenAt.has('session-a'), 'session file to be seen');

  listing.files = [];
  await waitFor(() => !server.runtime.state.isSessionAbsenceProtected('session-a'), 'period to end');
  server.runtime.state.syncSessionFiles([], Date.now() + 61_000);

  assert.equal(server.runtime.state.endedByAbsence.has('session-a'), true);
});

test('一覧を読めなかったときは、期間を終えず、不在の保護も外さない', async (t) => {
  const listing = fakeListing([sessionFile(100, 'session-a')]);
  listing.list = async () => (listing.files.length ? listing.files : null);
  const server = await startLineageServer(t, listing);
  assert.equal((await post(server, '/api/events', { ...hookEvent('session-a'), claudeLineage: { ppid: 100 } })).status, 202);

  listing.files = [];
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(server.runtime.state.isSessionAbsenceProtected('session-a'), true);
});
