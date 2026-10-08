'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const { createRegistrationKernel } = require('../src/server/conversation-registry');
const { createClaudeLocalIssuer } = require('../src/server/claude-local-issuer');

const CLAUDE_HOME = path.join(__dirname, 'no-such-claude-home');

function sessionFile(pid, sessionId, procStart = `start-${pid}`) {
  return { session_id: sessionId, pid, procStart, cwd: '', name: null, updatedAt: null };
}

function createFixture(options = {}) {
  const kernel = createRegistrationKernel();
  const state = { files: options.files || [], failure: null };
  const logs = [];
  const issuer = createClaudeLocalIssuer({
    registry: kernel.registry,
    authority: kernel.authority,
    claudeHome: CLAUDE_HOME,
    hostname: () => 'test-host',
    listSessionFiles: async () => {
      if (state.failure === 'throw') throw new Error('unreadable');
      if (state.failure === 'null') return null;
      return state.files.map((file) => ({ ...file }));
    },
    log: (message) => logs.push(message),
  });
  return { ...kernel, issuer, state, logs };
}

function executions(fixture) {
  return fixture.registry.snapshot().executions;
}

test('MCP の照合は親の pid のセッションファイルから writer を発行し、証拠の種類を記録する', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  const attested = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 555 });

  assert.equal(attested.ok, true);
  assert.equal(attested.writer.contextId, 'claude-mcp:555');
  assert.deepEqual(attested.writer.identity, {
    provider: 'claude',
    nativeIdKind: 'session',
    hostId: crypto.createHash('sha256').update('test-host').digest('hex'),
    homeScopeId: crypto.createHash('sha256').update(path.resolve(CLAUDE_HOME)).digest('hex'),
    nativeId: 'session-a',
  });
  const authorization = fixture.registry.authorizeWriter(attested.writer);
  assert.equal(authorization.ok, true);
  assert.equal(authorization.sessionId, 'session-a');

  const [execution] = executions(fixture);
  assert.equal(execution.state, 'active');
  assert.equal(execution.evidence.source, 'claude-local-lineage');
  assert.equal(execution.evidence.method, 'declared-ppid-session-file');
  assert.deepEqual(execution.evidence.capabilities, ['declared-lineage']);
  assert.ok(!JSON.stringify(fixture.registry.snapshot()).includes(attested.writer.token));
});

test('申告された ppid が親として確認できなければ、理由を区別して拒否し、副作用を残さない', async () => {
  const fixture = createFixture({
    files: [
      sessionFile(100, 'session-a'),
      { ...sessionFile(101, 'no-start'), procStart: null },
      sessionFile(102, 'duplicate-one'),
      sessionFile(102, 'duplicate-two', 'other-start'),
    ],
  });
  for (const ppid of [0, -1, 1.5, '100', null, undefined, 999, 101, 102]) {
    const result = await fixture.issuer.attestMcp({ ppid, contextPid: 1 });
    assert.deepEqual(result, { ok: false, reason: 'claude_parent_unverified' }, String(ppid));
  }
  assert.deepEqual(await fixture.issuer.attestMcp({ ppid: 100, contextPid: 0 }), { ok: false, reason: 'claude_context_invalid' });
  assert.deepEqual(await fixture.issuer.attachHookWriter({ ppid: 999, sessionId: 'session-a' }), {
    ok: false, reason: 'claude_parent_unverified',
  });

  fixture.state.failure = 'null';
  assert.deepEqual(await fixture.issuer.attestMcp({ ppid: 100, contextPid: 1 }), { ok: false, reason: 'claude_sessions_unreadable' });
  fixture.state.failure = 'throw';
  assert.deepEqual(await fixture.issuer.attestMcp({ ppid: 100, contextPid: 1 }), { ok: false, reason: 'claude_sessions_unreadable' });

  const snapshot = fixture.registry.snapshot();
  assert.equal(snapshot.conversations.length, 0);
  assert.equal(snapshot.executions.length, 0);
  assert.ok(fixture.logs.some((line) => line.includes('reason=claude_parent_unverified')));
  assert.ok(fixture.logs.some((line) => line.includes('reason=claude_sessions_unreadable')));
});

test('フックの照合は本文の session_id が親のセッションファイルと一致するときだけ通す', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  for (const sessionId of ['session-other', '', undefined, 42]) {
    const result = await fixture.issuer.attachHookWriter({ ppid: 100, sessionId });
    assert.deepEqual(result, { ok: false, reason: 'claude_session_mismatch' }, String(sessionId));
  }
  assert.equal(executions(fixture).length, 0);

  const attached = await fixture.issuer.attachHookWriter({ ppid: 100, sessionId: 'session-a' });
  assert.equal(attached.ok, true);
  assert.equal(attached.sessionId, 'session-a');
  assert.equal(attached.writer.contextId, 'claude-hooks');
  assert.equal(fixture.registry.authorizeEvent(attached.writer).ok, true);
});

test('MCP とフックのどちらが先に照合しても、同じ期間に冪等に解決する', async () => {
  for (const order of ['mcp-first', 'hook-first']) {
    const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
    const steps = order === 'mcp-first' ? ['mcp', 'hook'] : ['hook', 'mcp'];
    const results = {};
    for (const step of steps) {
      results[step] = step === 'mcp'
        ? await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 })
        : await fixture.issuer.attachHookWriter({ ppid: 100, sessionId: 'session-a' });
    }
    assert.equal(results.mcp.writer.executionId, results.hook.writer.executionId, order);
    assert.equal(executions(fixture).length, 1, order);
    assert.equal(fixture.registry.snapshot().conversations.length, 1, order);

    const hookAgain = await fixture.issuer.attachHookWriter({ ppid: 100, sessionId: 'session-a' });
    assert.equal(hookAgain.writer.token, results.hook.writer.token, order);
    assert.equal(fixture.registry.authorizeEvent(results.hook.writer).ok, true, order);
    assert.equal(fixture.registry.authorizeWriter(results.mcp.writer).ok, true, order);
  }
});

test('MCP が照合し直すと同じ contextId の古い token は失効し、フック用の writer は影響を受けない', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  const first = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });
  const hook = await fixture.issuer.attachHookWriter({ ppid: 100, sessionId: 'session-a' });
  const second = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });
  const other = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 8 });

  assert.notEqual(first.writer.token, second.writer.token);
  assert.equal(fixture.registry.authorizeWriter(first.writer).ok, false);
  assert.equal(fixture.registry.authorizeWriter(second.writer).ok, true);
  assert.equal(fixture.registry.authorizeWriter(other.writer).ok, true);
  assert.equal(fixture.registry.authorizeEvent(hook.writer).ok, true);
  // MCP の writer は別の contextId の照合には使えない。
  assert.equal(fixture.registry.authorizeWriter({ ...second.writer, contextId: 'claude-hooks' }).ok, false);
});

test('同じ親でセッション ID が変わると(/clear)、古い期間を終えて新しいセッションを登録する', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  const before = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });
  const hookBefore = await fixture.issuer.attachHookWriter({ ppid: 100, sessionId: 'session-a' });

  fixture.state.files = [sessionFile(100, 'session-b')];
  const stale = await fixture.issuer.attachHookWriter({ ppid: 100, sessionId: 'session-a' });
  assert.deepEqual(stale, { ok: false, reason: 'claude_session_mismatch' });
  const after = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });

  assert.equal(after.ok, true);
  assert.equal(after.writer.identity.nativeId, 'session-b');
  assert.notEqual(after.writer.executionId, before.writer.executionId);
  assert.equal(fixture.registry.authorizeWriter(before.writer).status, 'stale_execution');
  assert.equal(fixture.registry.authorizeEvent(hookBefore.writer).ok, false);
  assert.equal(fixture.registry.authorizeWriter(after.writer).sessionId, 'session-b');
  assert.equal(fixture.issuer.isActiveSession('session-a'), false);
  assert.equal(fixture.issuer.isActiveSession('session-b'), true);
  assert.deepEqual(executions(fixture).map((item) => item.state).sort(), ['active', 'ended']);
});

test('pid が別のプロセスに再利用されると、procStart が違うので別の期間になる', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a', 'start-1')] });
  const first = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });

  fixture.state.files = [sessionFile(100, 'session-a', 'start-2')];
  const second = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });

  assert.equal(second.ok, true);
  assert.notEqual(second.writer.executionId, first.writer.executionId);
  assert.equal(fixture.registry.authorizeWriter(first.writer).ok, false);
  assert.equal(fixture.registry.authorizeWriter(second.writer).ok, true);
  const conversations = fixture.registry.snapshot().conversations;
  assert.equal(conversations.length, 1);
});

test('一覧から鍵のプロセスが消えると期間を終え、その期間の writer をすべて失効させる', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a'), sessionFile(200, 'session-b')] });
  const mcp = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });
  const hook = await fixture.issuer.attachHookWriter({ ppid: 100, sessionId: 'session-a' });
  const survivor = await fixture.issuer.attestMcp({ ppid: 200, contextPid: 8 });

  fixture.issuer.syncSessionFiles([sessionFile(200, 'session-b')]);

  assert.equal(fixture.registry.authorizeWriter(mcp.writer).ok, false);
  assert.equal(fixture.registry.authorizeEvent(hook.writer).ok, false);
  assert.equal(fixture.registry.authorizeWriter(survivor.writer).ok, true);
  assert.equal(fixture.issuer.isActiveSession('session-a'), false);
  assert.equal(fixture.issuer.isActiveSession('session-b'), true);
  assert.equal(fixture.registry.isRegisteredSessionId('session-a'), true);
});

test('期間を作る前に読み始めた一覧は、その期間の不在の証拠にしない', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  const token = fixture.issuer.beginListing();
  const attested = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });

  fixture.issuer.syncSessionFiles([], token);
  assert.equal(fixture.registry.authorizeWriter(attested.writer).ok, true);

  fixture.issuer.syncSessionFiles([], fixture.issuer.beginListing());
  assert.equal(fixture.registry.authorizeWriter(attested.writer).ok, false);
});

test('一覧の読み直しでセッション ID が変わっていたら、古い期間を終える', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  const attested = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });

  fixture.issuer.syncSessionFiles([sessionFile(100, 'session-b')]);

  assert.equal(fixture.registry.authorizeWriter(attested.writer).ok, false);
  assert.equal(fixture.issuer.isActiveSession('session-a'), false);
});

test('一覧を読めなかった同期は何も終えない', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  const attested = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });

  fixture.issuer.syncSessionFiles(null);
  fixture.issuer.syncSessionFiles(undefined);

  assert.equal(fixture.registry.authorizeWriter(attested.writer).ok, true);
});

test('終えた期間と同じ鍵が一覧に戻ったら、同じ会話の新しい期間として登録し直す', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  const first = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });
  fixture.issuer.syncSessionFiles([]);
  assert.equal(fixture.issuer.isActiveSession('session-a'), false);

  const again = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });

  assert.equal(again.ok, true);
  assert.notEqual(again.writer.executionId, first.writer.executionId);
  assert.equal(fixture.registry.authorizeWriter(again.writer).ok, true);
  assert.equal(fixture.registry.snapshot().conversations.length, 1);
  // 再開した期間の表示用 sessionId は実行 ID になる。
  const hook = await fixture.issuer.attachHookWriter({ ppid: 100, sessionId: 'session-a' });
  assert.equal(hook.sessionId, again.writer.executionId);
  assert.equal(fixture.issuer.isActiveSession(hook.sessionId), true);
  assert.equal(fixture.issuer.isActiveSession('session-a'), false);
});

test('同じセッション ID が新しいプロセスに現れたら、再開として新しい期間を作る', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  const first = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });
  fixture.state.files = [sessionFile(300, 'session-a')];
  const resumed = await fixture.issuer.attestMcp({ ppid: 300, contextPid: 9 });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.writer.identity.nativeId, 'session-a');
  assert.notEqual(resumed.writer.executionId, first.writer.executionId);
  assert.equal(fixture.registry.authorizeWriter(first.writer).ok, false);
  assert.equal(fixture.registry.snapshot().conversations.length, 1);
});

test('生きたままの別プロセスが同じセッション ID を名乗ると、登録を拒否する', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a'), sessionFile(300, 'session-a')] });
  const first = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });
  const second = await fixture.issuer.attestMcp({ ppid: 300, contextPid: 9 });

  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: 'claude_registration_failed' });
  assert.equal(fixture.registry.authorizeWriter(first.writer).ok, true);
});

test('サブエージェントの agent_id は、この issuer の期間に限り verified にする', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  const attached = await fixture.issuer.attachHookWriter({ ppid: 100, sessionId: 'session-a' });
  const [conversation] = fixture.registry.snapshot().conversations;
  const registration = {
    provider: 'claude',
    identity: attached.writer.identity,
    conversationId: conversation.conversationId,
    executionId: attached.writer.executionId,
    sessionId: attached.sessionId,
  };

  const verified = fixture.issuer.resolveActorCorrelation({ provider: 'claude', registration, event: { agent_id: 'agent-1' } });
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.actor, { kind: 'agent', id: 'agent-1' });
  assert.equal(verified.binding.executionId, registration.executionId);
  assert.equal(verified.binding.sessionId, registration.sessionId);

  for (const agentId of ['', undefined, 7, ' padded ']) {
    const result = fixture.issuer.resolveActorCorrelation({ provider: 'claude', registration, event: { agent_id: agentId } });
    assert.equal(result.status, 'unverified', String(agentId));
  }
  const foreign = fixture.issuer.resolveActorCorrelation({
    provider: 'claude', registration: { ...registration, executionId: 'exec-foreign' }, event: { agent_id: 'agent-1' },
  });
  assert.equal(foreign.status, 'unverified');
  const codex = fixture.issuer.resolveActorCorrelation({ provider: 'codex', registration, event: { agent_id: 'agent-1' } });
  assert.equal(codex.status, 'unavailable');
});

test('ログと登録核の記録に token が残らない', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  const mcp = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });
  const hook = await fixture.issuer.attachHookWriter({ ppid: 100, sessionId: 'session-a' });
  await fixture.issuer.attestMcp({ ppid: 999, contextPid: 7 });
  fixture.issuer.syncSessionFiles([]);

  const text = JSON.stringify([fixture.logs, fixture.registry.snapshot()]);
  assert.ok(!text.includes(mcp.writer.token));
  assert.ok(!text.includes(hook.writer.token));
});

test('issuer は registry と authority と Claude のホームを要求する', () => {
  const kernel = createRegistrationKernel();
  assert.throws(() => createClaudeLocalIssuer({ registry: kernel.registry, authority: kernel.authority }), TypeError);
  assert.throws(() => createClaudeLocalIssuer({ registry: kernel.registry, claudeHome: CLAUDE_HOME }), TypeError);
});

function createHeldListing(initialFiles) {
  const controller = { files: initialFiles, held: null };
  controller.list = () => {
    const snapshot = controller.files.map((file) => ({ ...file }));
    if (!controller.held) return Promise.resolve(snapshot);
    const { gate } = controller.held;
    controller.held = null;
    return gate.then(() => snapshot);
  };
  // 次の 1 回の読み取りを、いまの一覧の内容のまま遅らせる。
  controller.holdNext = () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    controller.held = { gate };
    return release;
  };
  return controller;
}

test('セッション変更前の一覧を読んだ遅い照合は、新しい期間を終えも作り直しもしない', async (t) => {
  for (const kind of ['mcp', 'hook']) {
    await t.test(kind, async () => {
      const listing = createHeldListing([sessionFile(100, 'session-a')]);
      const kernel = createRegistrationKernel();
      const issuer = createClaudeLocalIssuer({
        registry: kernel.registry, authority: kernel.authority, claudeHome: CLAUDE_HOME, hostname: () => 'test-host',
        listSessionFiles: listing.list,
      });
      const first = await issuer.attestMcp({ ppid: 100, contextPid: 7 });

      const release = listing.holdNext();
      const late = kind === 'mcp'
        ? issuer.attestMcp({ ppid: 100, contextPid: 8 })
        : issuer.attachHookWriter({ ppid: 100, sessionId: 'session-a' });
      listing.files = [sessionFile(100, 'session-b')];
      const current = await issuer.attachHookWriter({ ppid: 100, sessionId: 'session-b' });
      assert.equal(current.ok, true);
      release();
      const result = await late;

      assert.equal(kernel.registry.authorizeEvent(current.writer).ok, true);
      assert.equal(issuer.isActiveSession('session-b'), true);
      assert.equal(issuer.isActiveSession('session-a'), false);
      assert.equal(kernel.registry.authorizeWriter(first.writer).ok, false);
      const states = kernel.registry.snapshot().executions.map((item) => item.state).sort();
      assert.deepEqual(states, ['active', 'ended']);
      if (kind === 'mcp') {
        assert.equal(result.ok, true);
        assert.equal(result.writer.identity.nativeId, 'session-b');
        assert.equal(result.writer.executionId, current.writer.executionId);
      } else {
        assert.deepEqual(result, { ok: false, reason: 'claude_session_mismatch' });
      }
    });
  }
});

test('writer の再確認は、親のセッションが変わっていれば期間を終え、変わらなければ何もしない', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  const attested = await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });

  await fixture.issuer.revalidateWriter(attested.writer);
  assert.equal(fixture.registry.authorizeWriter(attested.writer).ok, true);

  fixture.state.failure = 'null';
  fixture.state.files = [sessionFile(100, 'session-b')];
  await fixture.issuer.revalidateWriter(attested.writer);
  fixture.state.failure = 'throw';
  await fixture.issuer.revalidateWriter(attested.writer);
  assert.equal(fixture.registry.authorizeWriter(attested.writer).ok, true, '読めないときは登録核の照合に任せる');

  fixture.state.failure = null;
  await fixture.issuer.revalidateWriter({ executionId: 'exec-unknown' });
  await fixture.issuer.revalidateWriter(null);
  assert.equal(fixture.registry.authorizeWriter(attested.writer).ok, true);
  await fixture.issuer.revalidateWriter(attested.writer);
  assert.equal(fixture.registry.authorizeWriter(attested.writer).ok, false);
});

test('active な期間の表示用 sessionId を native の sessionId から引く', async () => {
  const fixture = createFixture({ files: [sessionFile(100, 'session-a')] });
  await fixture.issuer.attestMcp({ ppid: 100, contextPid: 7 });
  assert.equal(fixture.issuer.activeProjectionFor({ sessionId: 'session-a' }), 'session-a');
  assert.equal(fixture.issuer.activeProjectionFor({ sessionId: 'session-a', pid: 100 }), 'session-a');
  assert.equal(fixture.issuer.activeProjectionFor({ sessionId: 'session-a', pid: 101 }), null);
  assert.equal(fixture.issuer.activeProjectionFor({ sessionId: 'other' }), null);

  fixture.issuer.syncSessionFiles([]);
  fixture.state.files = [sessionFile(300, 'session-a')];
  const resumed = await fixture.issuer.attestMcp({ ppid: 300, contextPid: 9 });
  assert.equal(fixture.issuer.activeProjectionFor({ sessionId: 'session-a' }), resumed.writer.executionId);

  fixture.issuer.syncSessionFiles([]);
  assert.equal(fixture.issuer.activeProjectionFor({ sessionId: 'session-a' }), null);
});
