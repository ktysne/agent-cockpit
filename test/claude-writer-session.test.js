'use strict';

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const {
  startMcpServer, createClaudeWriterSession, UNREACHABLE_MESSAGE, WRITER_REQUIRED_MESSAGE,
} = require('../src/mcp/server');
const { postEvent } = require('../src/hooks/event');
const { postHookRequest } = require('../src/hooks/answer');

function writerEnvelope(token) {
  return {
    token,
    identity: { provider: 'claude', nativeIdKind: 'session', hostId: 'h', homeScopeId: 's', nativeId: 'native-session' },
    contextId: 'claude-mcp:9',
    executionId: 'exec-1',
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status });
}

async function exchange(calls, options) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
  const running = startMcpServer({ input, output, ...options });
  input.end(`${calls.map((call) => JSON.stringify(call)).join('\n')}\n`);
  await running;
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function toolCall(id, name, args) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

const TASK_ARGUMENTS = { tasks: [{ title: 'タスク', state: 'doing', criteria: [] }] };

function makeSession(responder, extra = {}) {
  const posts = [];
  const session = createClaudeWriterSession({
    ppid: 321,
    contextPid: 9,
    homeDir: 'C:\\unused-cockpit-home',
    ensureServerRunning: async () => ({ port: 49200, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      posts.push({ path: new URL(url).pathname, body });
      return responder(new URL(url).pathname, body, posts);
    },
    ...extra,
  });
  return { session, posts };
}

function mcpOptions(session, fetchOptions) {
  return {
    homeDir: 'C:\\unused-cockpit-home',
    ensureServerRunning: async () => ({ port: 49200, secret: 'test-secret' }),
    ...fetchOptions,
    getWriter: session.getWriter,
    getWriterFailure: session.getWriterFailure,
    refreshWriter: session.refreshWriter,
  };
}

test('照合は ppid と contextPid だけを送り、受け取った writer をメモリーに持つ', async () => {
  const { session, posts } = makeSession(() => jsonResponse(200, { writer: writerEnvelope('token-1') }));

  assert.equal(session.getWriter(), null);
  await session.refreshWriter();

  assert.deepEqual(posts, [{ path: '/api/claude/writer', body: { ppid: 321, contextPid: 9 } }]);
  assert.equal(session.getWriter().token, 'token-1');
  assert.equal(session.getWriterFailure(), null);
});

test('同時に来た照合は進行中の 1 回を共有する', async () => {
  const { session, posts } = makeSession(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return jsonResponse(200, { writer: writerEnvelope('shared') });
  });

  await Promise.all([session.refreshWriter(), session.refreshWriter(), session.refreshWriter()]);

  assert.equal(posts.length, 1);
  assert.equal(session.getWriter().token, 'shared');
});

test('拒否されたら writer を空にし、拒否の理由を保持する', async () => {
  let reply = jsonResponse(200, { writer: writerEnvelope('token-1') });
  const { session } = makeSession(() => reply);
  await session.refreshWriter();
  assert.ok(session.getWriter());

  reply = jsonResponse(403, { error: 'Writer unavailable', reason: 'claude_parent_unverified' });
  await session.refreshWriter();
  assert.equal(session.getWriter(), null);
  assert.equal(session.getWriterFailure(), 'claude_parent_unverified');

  reply = jsonResponse(500, { error: 'x' });
  await session.refreshWriter();
  assert.equal(session.getWriterFailure(), null);
});

test('discard を付けた照合は、失敗しても古い writer を残さない', async () => {
  let reply = jsonResponse(200, { writer: writerEnvelope('old') });
  const { session } = makeSession(() => reply);
  await session.refreshWriter();
  reply = jsonResponse(503, {});

  await session.refreshWriter(undefined, { discard: true });

  assert.equal(session.getWriter(), null);
});

test('書き込みが 403 で拒否されたら、照合し直して 1 回だけ送り直す', async () => {
  const writes = [];
  let current = writerEnvelope('stale');
  let refreshes = 0;
  const options = {
    homeDir: 'C:\\unused-cockpit-home',
    ensureServerRunning: async () => ({ port: 49200, secret: 'test-secret' }),
    getWriter: () => current,
    refreshWriter: async (_deadline, { discard }) => {
      refreshes += 1;
      assert.equal(discard, true);
      current = writerEnvelope('fresh');
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      writes.push(body.writer.token);
      return body.writer.token === 'stale' ? jsonResponse(403, { error: 'Writer unavailable' }) : jsonResponse(200, { tasks: [{ title: 'タスク', state: 'doing' }] });
    },
  };

  const [response] = await exchange([toolCall(1, 'cockpit_set_tasks', TASK_ARGUMENTS)], options);

  assert.equal(response.result.isError, undefined);
  assert.deepEqual(writes, ['stale', 'fresh']);
  assert.equal(refreshes, 1);
});

test('取り直しても 403 なら、それ以上は送らず writer のエラーにする', async () => {
  const writes = [];
  let refreshes = 0;
  const options = {
    homeDir: 'C:\\unused-cockpit-home',
    ensureServerRunning: async () => ({ port: 49200, secret: 'test-secret' }),
    getWriter: () => writerEnvelope('always-rejected'),
    getWriterFailure: () => null,
    refreshWriter: async () => { refreshes += 1; },
    fetchImpl: async (_url, init) => {
      writes.push(JSON.parse(init.body).writer.token);
      return jsonResponse(403, { error: 'Writer unavailable' });
    },
  };

  const responses = await exchange([
    toolCall(1, 'cockpit_set_tasks', TASK_ARGUMENTS),
    toolCall(2, 'cockpit_add_pr', { url: 'https://github.com/example/project/pull/1' }),
  ], options);

  assert.ok(responses.every((response) => response.result.isError === true));
  assert.ok(responses.every((response) => response.result.content[0].text === WRITER_REQUIRED_MESSAGE));
  assert.equal(writes.length, 4);
  assert.equal(refreshes, 2);
});

test('writer が無いときは書く前に 1 回照合し、拒否の理由を MCP のエラー文で区別して示す', async () => {
  const messages = new Map([
    ['claude_parent_unverified', /親プロセスを Claude と確認できませんでした/],
    ['claude_sessions_unreadable', /セッションファイルを読めない/],
    ['claude_session_mismatch', /セッションを確認できませんでした/],
  ]);
  for (const [reason, pattern] of messages) {
    const { session, posts } = makeSession(() => jsonResponse(403, { error: 'Writer unavailable', reason }));
    const writes = [];
    const responses = await exchange([toolCall(1, 'cockpit_set_tasks', TASK_ARGUMENTS)], mcpOptions(session, {
      fetchImpl: async (url, init) => {
        const target = new URL(url).pathname;
        if (target === '/api/claude/writer') return jsonResponse(403, { error: 'Writer unavailable', reason });
        writes.push(init.body);
        return jsonResponse(200, {});
      },
    }));

    assert.equal(responses[0].result.isError, true, reason);
    assert.match(responses[0].result.content[0].text, pattern, reason);
    assert.deepEqual(writes, [], reason);
    assert.equal(posts.length, 1, reason);
  }
});

test('照合が成功すれば、writer が無かった呼び出しもそのまま書き込める', async () => {
  const { session } = makeSession(() => jsonResponse(200, { writer: writerEnvelope('fresh') }));
  const writes = [];

  const responses = await exchange([
    toolCall(1, 'cockpit_set_tasks', TASK_ARGUMENTS),
    toolCall(2, 'cockpit_add_decision', { title: '判断', context: '', state: 'waiting', options: [] }),
  ], mcpOptions(session, {
    fetchImpl: async (url, init) => {
      const target = new URL(url).pathname;
      if (target === '/api/claude/writer') return jsonResponse(200, { writer: writerEnvelope('fresh') });
      writes.push(JSON.parse(init.body).writer.token);
      return jsonResponse(200, target.endsWith('/plan') ? { tasks: [], decision: { id: 'd1', title: '判断', state: 'waiting' } } : {});
    },
  }));

  assert.ok(responses.every((response) => response.result.isError === undefined));
  assert.deepEqual(writes, ['fresh', 'fresh']);
});

test('refreshWriter を持たない構成では、従来どおり 403 を到達不能として扱う', async () => {
  const responses = await exchange([toolCall(1, 'cockpit_set_tasks', TASK_ARGUMENTS)], {
    homeDir: 'C:\\unused-cockpit-home',
    ensureServerRunning: async () => ({ port: 49200, secret: 'test-secret' }),
    writer: writerEnvelope('fixed'),
    fetchImpl: async () => jsonResponse(403, { error: 'Writer unavailable' }),
  });

  assert.equal(responses[0].result.content[0].text, UNREACHABLE_MESSAGE);
});

test('event.js と answer.js は親プロセスの pid を claudeLineage として送る', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response('{}', { status: 202 });
  };
  const info = { port: 49201, secret: 'test-secret' };

  await postEvent({ session_id: 'session-x', hook_event_name: 'Stop' }, {
    homeDir: 'C:\\unused-cockpit-home', fetchImpl, initialInfo: info, ppid: 777,
  });
  await postHookRequest({ action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: 'session-x', id: 'id-1' }, {
    homeDir: 'C:\\unused-cockpit-home', fetchImpl, readServerInfo: async () => info, ppid: 888,
  });
  await postEvent({ session_id: 'session-x', hook_event_name: 'Stop' }, {
    homeDir: 'C:\\unused-cockpit-home', fetchImpl, initialInfo: info,
  });

  assert.deepEqual(bodies[0].claudeLineage, { ppid: 777 });
  assert.deepEqual(bodies[1].claudeLineage, { ppid: 888 });
  assert.deepEqual(bodies[2].claudeLineage, { ppid: process.ppid });
  assert.equal('writer' in bodies[0], false);
});
