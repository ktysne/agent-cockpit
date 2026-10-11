const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough, Writable } = require('node:stream');
const {
  startMcpServer,
  MCP_GITHUB_TIMEOUT_MS,
  TIMEOUT_MESSAGE,
  UNREACHABLE_MESSAGE,
  WRITER_REQUIRED_MESSAGE,
} = require('../src/mcp/server');

function makeWriter(provider = 'claude', nativeId = 'mcp-session') {
  return {
    token: 'registered-writer-token',
    identity: {
      provider,
      nativeIdKind: provider === 'codex' ? 'thread' : 'session',
      hostId: 'host-fixture',
      homeScopeId: 'home-fixture',
      nativeId,
    },
    contextId: 'context-fixture',
    executionId: 'execution-fixture',
  };
}

async function exchange(requests, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
  const running = startMcpServer({ input, output, ...options });
  input.end(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
  await running;
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('MCP stdio は initialize、tools/list、tools/call に応答する', async () => {
  let sent = null;
  const writer = makeWriter();
  const responses = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'cockpit_set_tasks', arguments: { tasks: [{ title: 'テストを書く', state: 'doing', criteria: [] }] } },
    },
  ], {
    homeDir: 'C:\\temporary-cockpit',
    environment: {
      CLAUDE_CODE_SESSION_ID: 'mcp-session',
      CLAUDE_CODE_MESSAGING_TOKEN: 'must-not-be-sent',
      PRIVATE_ENV_VALUE: 'also-must-not-be-sent',
    },
    writer,
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ tasks: [{ title: 'テストを書く', state: 'doing' }] }), { status: 200 });
    },
  });
  assert.equal(responses.length, 3);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].result.serverInfo.name, 'agent-cockpit');
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), [
    'cockpit_set_tasks', 'cockpit_add_decision', 'cockpit_update_decision', 'cockpit_register_question', 'cockpit_question_status', 'cockpit_answer_poll', 'cockpit_add_pr', 'cockpit_skip_review',
  ]);
  const questionTool = responses[1].result.tools.find((tool) => tool.name === 'cockpit_register_question');
  assert.match(questionTool.description, /通常判断の質問/);
  assert.match(questionTool.description, /回答pollで一度だけ取得/);
  assert.match(questionTool.description, /許可や承認の要求、nativeの待機には使用しません/);
  assert.match(questionTool.description, /Claudeのnative AskUserQuestionも共通質問へ再登録しません/);
  assert.equal(responses[2].id, 3);
  assert.match(responses[2].result.content[0].text, /テストを書く \(doing\)/);
  assert.equal(sent.url, 'http://127.0.0.1:49124/api/sessions/pending/plan');
  assert.equal(sent.headers['x-cockpit-secret'], 'test-secret');
  assert.equal(sent.body.kind, 'tasks');
  assert.deepEqual(sent.body.writer, writer);
  assert.equal('ppid' in sent.body, false);
  assert.equal('claudeCodeSessionId' in sent.body, false);
  assert.ok(!JSON.stringify(sent).includes('must-not-be-sent'));
  assert.ok(!JSON.stringify(sent).includes('also-must-not-be-sent'));
  assert.ok(!JSON.stringify(responses).includes('also-must-not-be-sent'));
  assert.ok(!JSON.stringify(responses).includes('test-secret'));
  assert.ok(!JSON.stringify(responses).includes(writer.token));
});

test('cockpit_add_pr は PR URL を秘密値付きで常駐サーバーへ登録する', async () => {
  let sent = null;
  const writer = makeWriter();
  const cwd = 'D:\\project\\.claude\\worktrees\\mcp-session';
  const responses = await exchange([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_add_pr', arguments: { url: 'https://github.com/example/project/pull/45' } },
  }], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    cwd,
    writer,
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ owner: 'example', repo: 'project', number: 45, url: 'https://github.com/example/project/pull/45' }), { status: 200 });
    },
  });
  assert.equal(responses[0].result.isError, undefined);
  assert.match(responses[0].result.content[0].text, /PR #45/);
  assert.equal(sent.url, 'http://127.0.0.1:49124/api/sessions/pending/prs');
  assert.equal(sent.headers['x-cockpit-secret'], 'test-secret');
  assert.equal(sent.headers.origin, undefined);
  assert.deepEqual([sent.body.kind, sent.body.url, sent.body.cwd, sent.body.writer], [
    'add_pr', 'https://github.com/example/project/pull/45', cwd, writer,
  ]);
  assert.equal('claudeCodeSessionId' in sent.body, false);
});

test('cockpit_skip_review は理由と指定 head を秘密値付きで常駐サーバーへ記録する', async () => {
  let sent = null;
  const headRefOid = 'a'.repeat(40);
  const writer = makeWriter();
  const responses = await exchange([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_skip_review', arguments: {
      owner: 'example', repo: 'project', number: 45, headRefOid, reason: '変更が説明文だけのため',
    } },
  }], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    writer,
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ number: 45, owner: 'example', repo: 'project', headRefOid }), { status: 200 });
    },
  });

  assert.equal(responses[0].result.isError, undefined);
  assert.match(responses[0].result.content[0].text, /クロスレビュー不要として記録しました/);
  assert.equal(sent.url, 'http://127.0.0.1:49124/api/sessions/pending/prs');
  assert.equal(sent.headers['x-cockpit-secret'], 'test-secret');
  assert.equal(sent.headers.origin, undefined);
  assert.deepEqual([
    sent.body.kind, sent.body.owner, sent.body.repo, sent.body.number,
    sent.body.headRefOid, sent.body.reason, sent.body.writer,
  ], ['skip_review', 'example', 'project', 45, headRefOid, '変更が説明文だけのため', writer]);
});

test('MCPは旧Claude IDだけでは書き込まず、未binding入力をHTTP送信しない', async () => {
  const calls = [
    ['cockpit_set_tasks', { tasks: [] }],
    ['cockpit_add_pr', { url: 'https://github.com/example/project/pull/45' }],
    ['cockpit_skip_review', {
      owner: 'example', repo: 'project', number: 45, headRefOid: 'a'.repeat(40), reason: '確認済み',
    }],
  ];

  for (const [name, argumentsValue] of calls) {
    let fetchCount = 0;
    const responses = await exchange([{
      jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: argumentsValue },
    }], {
      homeDir: 'C:\\temporary-cockpit',
      environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
      ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
      fetchImpl: async () => { fetchCount += 1; return new Response('{}', { status: 200 }); },
    });
    assert.equal(responses[0].result.isError, true, name);
    assert.equal(responses[0].result.content[0].text, WRITER_REQUIRED_MESSAGE, name);
    assert.equal(fetchCount, 0, name);
  }
});

test('Codex MCPは一致するthread metadataだけを書き込み、並行呼び出しのmetadataを共有しない', async () => {
  let fetchCount = 0;
  let sent = null;
  const writer = makeWriter('codex', 'codex-thread');
  const responses = await exchange([
    {
      jsonrpc: '2.0', id: 'matching', method: 'tools/call',
      params: {
        name: 'cockpit_set_tasks', arguments: { tasks: [] },
        _meta: { provider: 'codex', threadId: 'codex-thread' },
      },
    },
    {
      jsonrpc: '2.0', id: 'mismatching', method: 'tools/call',
      params: {
        name: 'cockpit_set_tasks', arguments: { tasks: [] },
        _meta: { provider: 'codex', threadId: 'other-thread' },
      },
    },
  ], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'inherited-claude-session' },
    writer,
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      fetchCount += 1;
      sent = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
    },
  });
  const byId = new Map(responses.map((response) => [response.id, response]));

  assert.equal(byId.get('matching').result.isError, undefined);
  assert.equal(byId.get('mismatching').result.isError, true);
  assert.equal(fetchCount, 1);
  assert.equal(sent.url, 'http://127.0.0.1:49124/api/sessions/pending/plan');
  assert.deepEqual(sent.body.writer, writer);
  assert.equal('claudeCodeSessionId' in sent.body, false);
});

test('unknown metadata provider、異なるClaude metadata、未対応writer providerを拒否する', async () => {
  const cases = [
    { writer: makeWriter(), meta: { provider: 'future-provider' } },
    { writer: makeWriter(), meta: { provider: 'codex', threadId: 'codex-thread' } },
    { writer: makeWriter('openai', 'openai-thread'), meta: { provider: 'openai', threadId: 'openai-thread' } },
  ];

  for (const [index, { writer, meta }] of cases.entries()) {
    let fetchCount = 0;
    const responses = await exchange([{
      jsonrpc: '2.0', id: index, method: 'tools/call',
      params: { name: 'cockpit_set_tasks', arguments: { tasks: [] }, _meta: meta },
    }], {
      homeDir: 'C:\\temporary-cockpit',
      environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
      writer,
      ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
      fetchImpl: async () => { fetchCount += 1; return new Response('{}', { status: 200 }); },
    });
    assert.equal(responses[0].result.isError, true, String(index));
    assert.equal(fetchCount, 0, String(index));
  }
});

test('MCP tools/call は呼出し元の宛先claimをHTTP送信前に拒否する', async () => {
  const destinationClaims = [
    'session_id', 'sessionId', 'threadId', 'conversationId', 'conversation_id',
    'executionId', 'execution_id', 'provider', 'nativeId', 'nativeIdKind',
    'hostId', 'homeScopeId', 'contextId', 'contextToken', 'token', 'writer',
  ];
  const responsesExpected = destinationClaims.map((claim, index) => ({
    jsonrpc: '2.0', id: index, method: 'tools/call',
    params: {
      name: 'cockpit_set_tasks',
      arguments: { tasks: [], [claim]: 'caller-selected-destination' },
    },
  }));
  let ensureCount = 0;
  let fetchCount = 0;
  const responses = await exchange(responsesExpected, {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    writer: makeWriter(),
    ensureServerRunning: async () => {
      ensureCount += 1;
      return { port: 49124, secret: 'test-secret' };
    },
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response('{}', { status: 200 });
    },
  });

  assert.equal(responses.length, destinationClaims.length);
  assert.ok(responses.every((response) => response.result.isError === true));
  assert.ok(responses.every((response) => response.result.content[0].text === '入力が正しくありません。'));
  assert.equal(ensureCount, 0);
  assert.equal(fetchCount, 0);
});

test('cockpit_skip_review は GitHub 同期の 60 秒期限内に応答した要求を記録する', async () => {
  let observedDeadline;
  let requestCount = 0;
  let requestWasAborted = false;
  const nowValue = 100000;
  const headRefOid = 'a'.repeat(40);
  const responses = await exchange([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_skip_review', arguments: {
      owner: 'example', repo: 'project', number: 45, headRefOid, reason: '変更が説明文だけのため',
    } },
  }], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    writer: makeWriter(),
    now: () => nowValue,
    ensureServerRunning: async ({ deadline }) => {
      observedDeadline = deadline;
      return { port: 49124, secret: 'test-secret' };
    },
    fetchImpl: async (_url, init) => {
      requestCount += 1;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2100);
        init.signal.addEventListener('abort', () => {
          requestWasAborted = true;
          clearTimeout(timer);
          reject(new Error('aborted'));
        }, { once: true });
      });
      return new Response(JSON.stringify({ number: 45, owner: 'example', repo: 'project', headRefOid }), { status: 200 });
    },
  });

  assert.equal(MCP_GITHUB_TIMEOUT_MS, 60000);
  assert.equal(observedDeadline, nowValue + MCP_GITHUB_TIMEOUT_MS);
  assert.equal(requestWasAborted, false);
  assert.equal(requestCount, 1);
  assert.equal(responses[0].result.isError, undefined);
  assert.match(responses[0].result.content[0].text, /クロスレビュー不要として記録しました/);
});

test('400 と 404 は理由を示す固定文を isError で返す', async () => {
  for (const [status, message] of [
    [400, '入力が正しくないか、上限を超えています'],
    [404, '判断事項が見つからないか、解決済みです'],
  ]) {
    const responses = await exchange([{
      jsonrpc: '2.0', id: status, method: 'tools/call',
      params: { name: 'cockpit_update_decision', arguments: { id: 'decision-1', state: 'resolved', chosen: [], note: '' } },
    }], {
      homeDir: 'C:\\temporary-cockpit',
      environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
      writer: makeWriter(),
      ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
      fetchImpl: async () => new Response('{}', { status }),
    });
    assert.equal(responses[0].result.isError, true);
    assert.equal(responses[0].result.content[0].text, message);
  }
});

test('常駐サーバーに届かない tools/call は isError で継続可能と伝える', async () => {
  const responses = await exchange([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_set_tasks', arguments: { tasks: [] } },
  }], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    writer: makeWriter(),
    ensureServerRunning: async () => null,
  });
  assert.equal(responses[0].result.isError, true);
  assert.equal(responses[0].result.content[0].text, UNREACHABLE_MESSAGE);
});

test('3 種類の MCP 書き込みは未知の失敗と再試行後の 401 を到達不能として返す', async () => {
  const calls = [
    ['cockpit_set_tasks', { tasks: [] }],
    ['cockpit_add_pr', { url: 'https://github.com/example/project/pull/45' }],
    ['cockpit_skip_review', {
      owner: 'example', repo: 'project', number: 45, headRefOid: 'a'.repeat(40), reason: '記録しない理由',
    }],
  ];

  for (const [index, [name, argumentsValue]] of calls.entries()) {
    for (const status of [500, 401]) {
      let fetchCount = 0;
      const responses = await exchange([{
        jsonrpc: '2.0', id: index * 10 + status, method: 'tools/call',
        params: { name, arguments: argumentsValue },
      }], {
        homeDir: 'C:\\temporary-cockpit',
        environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
        writer: makeWriter(),
        ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
        readServerInfo: async () => ({ port: 49125, secret: 'updated-secret' }),
        fetchImpl: async () => {
          fetchCount += 1;
          return new Response('{}', { status });
        },
      });
      assert.equal(responses[0].result.isError, true, `${name} with HTTP ${status}`);
      assert.equal(responses[0].result.content[0].text, UNREACHABLE_MESSAGE, `${name} with HTTP ${status}`);
      assert.equal(fetchCount, status === 401 ? 2 : 1, `${name} with HTTP ${status}`);
    }
  }
});

function commonQuestionInput() {
  return {
    questionId: 'question-fixture',
    questions: [{
      id: 'choice',
      text: 'どの案を選びますか？',
      mode: 'single',
      options: [{ id: 'a', label: '案 A', description: '' }],
      allowFreeText: true,
      recommendedOptionId: null,
    }],
    timeoutMinutes: 5,
  };
}

test('共通質問MCPの引数から信頼済み自動適用設定を指定できない', async () => {
  let requests = 0;
  const response = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'cockpit_register_question', arguments: { ...commonQuestionInput(), autoApplyEnabled: true } } },
  ], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    writer: makeWriter(),
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async () => { requests += 1; throw new Error('invalid MCP arguments reached HTTP'); },
  });
  assert.equal(response[0].result.isError, true);
  assert.equal(requests, 0);
});

test('共通質問のMCP登録と状態pollは回答値を返さずwriterを固定経路へ送る', async () => {
  const writer = makeWriter();
  const requests = [];
  const question = {
    internalQuestionId: 'cq-fixture',
    questionId: 'question-fixture',
    revision: 0,
    createdAt: 10,
    deadlineAt: 300010,
    held: false,
    selectionSource: null,
    deliveryAttemptId: null,
    deliveryState: null,
  };
  const responses = await exchange([
    {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'cockpit_register_question', arguments: commonQuestionInput() },
    },
    {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'cockpit_question_status', arguments: { questionId: 'question-fixture' } },
    },
  ], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    writer,
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      requests.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(requests.at(-1).path.endsWith('/register')
        ? { outcome: 'created', question }
        : question), { status: 200 });
    },
  });
  assert.deepEqual(requests.map(({ path }) => path), [
    '/api/sessions/pending/questions/register',
    '/api/sessions/pending/questions/status',
  ]);
  assert.deepEqual(requests.map(({ body }) => body.writer), [writer, writer]);
  assert.equal(requests[0].body.category, undefined);
  assert.equal(requests[0].body.timeoutMinutes, 5);
  assert.equal(requests[1].body.questionId, 'question-fixture');
  assert.equal(responses[0].result.isError, undefined);
  assert.equal(responses[1].result.isError, undefined);
  assert.ok(!JSON.stringify(responses).includes('どの案を選びますか？'));
  assert.ok(!JSON.stringify(responses).includes('案 A'));
});

test('共通質問の送信後タイムアウトは結果不明、未送信は到達不能として案内する', async () => {
  const calls = [
    ['cockpit_register_question', commonQuestionInput(), '/api/sessions/pending/questions/register'],
    ['cockpit_question_status', { questionId: 'question-fixture' }, '/api/sessions/pending/questions/status'],
    ['cockpit_answer_poll', { questionId: 'question-fixture' }, '/api/sessions/pending/questions/answer-poll'],
  ];

  for (const [index, [name, argumentsValue, route]] of calls.entries()) {
    const requests = [];
    const responses = await exchange([{
      jsonrpc: '2.0', id: index + 1, method: 'tools/call',
      params: { name, arguments: argumentsValue },
    }], {
      homeDir: 'C:\\temporary-cockpit',
      environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
      writer: makeWriter(),
      deadline: Date.now() + 3000,
      ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
      fetchImpl: async (url, init) => {
        const pathname = new URL(url).pathname;
        requests.push(pathname);
        if (pathname.endsWith('/response-lost')) return new Response('{}', { status: 200 });
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });

    assert.equal(responses[0].result.isError, true, name);
    assert.equal(responses[0].result.content[0].text, TIMEOUT_MESSAGE, name);
    assert.deepEqual(requests, name === 'cockpit_answer_poll'
      ? [route, '/api/sessions/pending/questions/response-lost']
      : [route], name);
  }

  for (const [index, [name, argumentsValue]] of calls.entries()) {
    let fetchCount = 0;
    const responses = await exchange([{
      jsonrpc: '2.0', id: index + 4, method: 'tools/call',
      params: { name, arguments: argumentsValue },
    }], {
      homeDir: 'C:\\temporary-cockpit',
      environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
      writer: makeWriter(),
      ensureServerRunning: async () => null,
      fetchImpl: async () => { fetchCount += 1; return new Response('{}', { status: 200 }); },
    });

    assert.equal(responses[0].result.isError, true, name);
    assert.equal(responses[0].result.content[0].text, UNREACHABLE_MESSAGE, name);
    assert.equal(fetchCount, 0, name);
  }
});

test('共通質問answer-pollはsink結果だけを出力し、stdio書込み失敗を同じ質問IDで通知する', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(chunk, encoding, callback) { callback(new Error('output unavailable')); } });
  const writer = makeWriter();
  const paths = [];
  const running = startMcpServer({
    input,
    output,
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    writer,
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      const body = JSON.parse(init.body);
      paths.push({ pathname, body });
      if (pathname.endsWith('/answer-poll')) {
        return new Response(JSON.stringify({
          status: { questionId: body.questionId, deliveryAttemptId: 'delivery-1', deliveryState: 'sending' },
          delivery: {
            questionId: body.questionId,
            revision: 2,
            deliveryAttemptId: 'delivery-1',
            answers: [{ questionId: 'choice', optionIds: ['a'], freeText: '保存した答え' }],
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ outcome: 'unknown' }), { status: 200 });
    },
  });
  input.end(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_answer_poll', arguments: { questionId: 'question-fixture' } },
  }) + '\n');
  await running;
  assert.deepEqual(paths.map(({ pathname }) => pathname), [
    '/api/sessions/pending/questions/answer-poll',
    '/api/sessions/pending/questions/response-lost',
  ]);
  assert.equal(paths[1].body.questionId, 'question-fixture');
  assert.deepEqual(paths[1].body.writer, writer);
});
test('answer-pollは通信失敗時にPOSTを再送せず、同一質問のresponse-lostだけを一度通知する', async () => {
  const writer = makeWriter();
  const requests = [];
  const responses = await exchange([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_answer_poll', arguments: { questionId: 'question-fixture' } },
  }], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    writer,
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      requests.push({ pathname, body: JSON.parse(init.body) });
      if (pathname.endsWith('/answer-poll')) throw new Error('HTTP response lost');
      return new Response(JSON.stringify({ outcome: 'unknown' }), { status: 200 });
    },
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.isError, true);
  assert.deepEqual(requests.map(({ pathname }) => pathname), [
    '/api/sessions/pending/questions/answer-poll',
    '/api/sessions/pending/questions/response-lost',
  ]);
  assert.equal(requests[0].body.questionId, requests[1].body.questionId);
  assert.deepEqual(requests[0].body.writer, requests[1].body.writer);
});

test('MCPの書き込み結果不明は固定案内を返し、同じ要求やrefreshを再送しない', async () => {
  const unknownMessage = '処理結果を確認できません。同じ書き込みを繰り返す前に、ダッシュボードで反映状態を確認してください。';
  const calls = [
    ['cockpit_set_tasks', { tasks: [] }],
    ['cockpit_add_decision', {
      title: '確認する', context: '結果が不明な場合', state: 'waiting',
      options: [{ label: '状態を見る', description: '', recommended: true }],
    }],
    ['cockpit_update_decision', { id: 'decision-1', state: 'resolved', chosen: '状態を見る', note: '' }],
    ['cockpit_add_pr', { url: 'https://github.com/example/project/pull/45' }],
    ['cockpit_skip_review', {
      owner: 'example', repo: 'project', number: 45, headRefOid: 'a'.repeat(40), reason: '理由を記録する',
    }],
    ['cockpit_register_question', commonQuestionInput()],
    ['cockpit_question_status', { questionId: 'question-fixture' }],
    ['cockpit_answer_poll', { questionId: 'question-fixture' }],
  ];
  const fakeFailure = Object.freeze(Object.assign(new Error('private URL and payload'), {
    requestStarted: false,
    code: 'DEADLINE_TIMEOUT',
  }));
  const paths = [];
  let ensureCalls = 0;
  let refreshCalls = 0;
  const responses = await exchange(calls.map(([name, argumentsValue], index) => ({
    jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: argumentsValue },
  })), {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    writer: makeWriter(),
    refreshWriter: async () => { refreshCalls += 1; },
    ensureServerRunning: async () => {
      ensureCalls += 1;
      return { port: 49124, secret: 'test-secret' };
    },
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      throw fakeFailure;
    },
  });
  const byId = new Map(responses.map((response) => [response.id, response]));

  assert.equal(responses.length, calls.length);
  for (const [index] of calls.entries()) {
    assert.equal(byId.get(index + 1).result.isError, true);
    assert.equal(byId.get(index + 1).result.content[0].text, unknownMessage);
  }
  assert.equal(paths.length, calls.length + 1);
  assert.equal(paths.filter((pathname) => pathname.endsWith('/response-lost')).length, 1);
  assert.equal(ensureCalls, calls.length + 1);
  assert.equal(refreshCalls, 0);
  assert.ok(!JSON.stringify(responses).includes('private URL and payload'));
  assert.ok(!JSON.stringify(responses).includes('test-secret'));
  assert.ok(!JSON.stringify(responses).includes('registered-writer-token'));
});

test('MCP stdioは実HTTP切断とmalformed JSON後にClaude/Codex双方で一度だけ送信する', async (t) => {
  const unknownMessage = '処理結果を確認できません。同じ書き込みを繰り返す前に、ダッシュボードで反映状態を確認してください。';
  const modes = ['disconnect', 'malformed-json'];
  const counters = () => Object.fromEntries(modes.map((mode) => [mode, { claude: 0, codex: 0 }]));
  const posts = [];
  const postCount = counters();
  const effectCount = counters();
  const rawPostCount = Object.fromEntries(modes.map((mode) => [mode, 0]));
  let activeMode = null;
  const server = http.createServer((request, response) => {
    const mode = activeMode;
    if (request.method === 'POST') rawPostCount[mode] += 1;
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch {
        response.writeHead(400, { connection: 'close' });
        response.end();
        return;
      }
      const entry = { mode, path: request.url, secret: request.headers['x-cockpit-secret'], body };
      posts.push(entry);
      const provider = body.writer?.identity?.provider;
      if (request.method === 'POST' && ['claude', 'codex'].includes(provider)) postCount[mode][provider] += 1;
      if (request.method === 'POST' && request.url === '/api/sessions/pending/plan' &&
          request.headers['x-cockpit-secret'] === 'fixture-secret' && body.kind === 'tasks' &&
          ['claude', 'codex'].includes(provider)) {
        effectCount[mode][provider] += 1;
      }
      if (mode === 'disconnect') {
        response.destroy();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end('{');
    });
  });
  await new Promise((resolve, reject) => {
    const fail = (error) => reject(error);
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      resolve();
    });
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const { port } = server.address();

  for (const mode of modes) {
    for (const provider of ['claude', 'codex']) {
      activeMode = mode;
      const writer = makeWriter(provider, provider === 'codex' ? 'mcp-thread' : 'mcp-session');
      const request = {
        jsonrpc: '2.0', id: `${mode}-${provider}`, method: 'tools/call',
        params: {
          name: 'cockpit_set_tasks', arguments: { tasks: [] },
          ...(provider === 'codex' ? { _meta: { provider: 'codex', threadId: 'mcp-thread' } } : {}),
        },
      };
      let ensureCalls = 0;
      let refreshCalls = 0;
      const responses = await exchange([request], {
        homeDir: 'C:\\temporary-cockpit',
        environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
        writer,
        refreshWriter: async () => { refreshCalls += 1; },
        ensureServerRunning: async () => {
          ensureCalls += 1;
          return { port, secret: 'fixture-secret' };
        },
      });

      assert.equal(responses[0].result.isError, true, `${mode}/${provider}`);
      assert.equal(responses[0].result.content[0].text, unknownMessage, `${mode}/${provider}`);
      assert.ok(!JSON.stringify(responses).includes('fixture-secret'), `${mode}/${provider}`);
      assert.ok(!JSON.stringify(responses).includes(writer.token), `${mode}/${provider}`);
      assert.equal(ensureCalls, 1, `${mode}/${provider}`);
      assert.equal(refreshCalls, 0, `${mode}/${provider}`);
      assert.equal(postCount[mode][provider], 1, `${mode}/${provider} POST`);
      assert.equal(effectCount[mode][provider], 1, `${mode}/${provider} effect`);
    }
  }

  for (const mode of modes) assert.equal(rawPostCount[mode], 2, mode);
  assert.equal(posts.length, 4);
  assert.ok(posts.every((entry) => entry.path === '/api/sessions/pending/plan'));
});

test('getWriterは各tools/callで一度だけ同期取得し、その呼出しのwriterを固定する', async () => {
  const firstWriter = makeWriter();
  const secondWriter = structuredClone(firstWriter);
  firstWriter.contextId = 'context-first';
  firstWriter.executionId = 'execution-first';
  secondWriter.contextId = 'context-second';
  secondWriter.executionId = 'execution-second';
  const requests = [];
  let getterCalls = 0;
  const responses = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'cockpit_register_question', arguments: commonQuestionInput() },
    },
    {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'cockpit_question_status', arguments: { questionId: 'question-fixture' } },
    },
  ], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    getWriter() {
      getterCalls += 1;
      return getterCalls === 1 ? firstWriter : secondWriter;
    },
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      requests.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ questionId: 'question-fixture', deliveryState: null }), { status: 200 });
    },
  });

  assert.equal(responses.length, 4);
  assert.equal(getterCalls, 2);
  assert.deepEqual(requests.map(({ body }) => [body.writer.contextId, body.writer.executionId]), [
    ['context-first', 'execution-first'],
    ['context-second', 'execution-second'],
  ]);
});

test('getWriterはkernelと同じnull-prototype data envelopeを受け入れてコピーする', async () => {
  const original = makeWriter();
  const writer = Object.assign(Object.create(null), original);
  writer.identity = Object.assign(Object.create(null), original.identity);
  let sentWriter = null;
  const responses = await exchange([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_question_status', arguments: { questionId: 'question-fixture' } },
  }], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    getWriter: () => writer,
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      sentWriter = JSON.parse(init.body).writer;
      return new Response('{"questionId":"question-fixture"}', { status: 200 });
    },
  });
  assert.equal(responses[0].result.isError, undefined);
  assert.deepEqual(sentWriter, original);
});

test('getWriterの異常値や固定writerとの併用はfail-closedでHTTPへ送らない', async () => {
  const cases = [
    { name: 'not a function', getWriter: true },
    { name: 'throws', getWriter() { throw new Error('fixture'); } },
    { name: 'returns a promise', getWriter: async () => makeWriter() },
    { name: 'returns rejected promise', getWriter: () => Promise.reject(new Error('fixture')) },
    { name: 'returns null', getWriter: () => null },
    { name: 'extra key', getWriter: () => ({ ...makeWriter(), untrusted: true }) },
    { name: 'symbol key', getWriter: () => Object.assign(makeWriter(), { [Symbol('extra')]: true }) },
    { name: 'non-enumerable key', getWriter: () => {
      const writer = makeWriter();
      Object.defineProperty(writer, 'hidden', { value: true });
      return writer;
    } },
    { name: 'accessor field', getWriter: () => {
      const writer = makeWriter();
      Object.defineProperty(writer, 'contextId', { get() { return 'context-fixture'; }, enumerable: true });
      return writer;
    } },
    { name: 'non-enumerable field', getWriter: () => {
      const writer = makeWriter();
      Object.defineProperty(writer, 'contextId', { value: 'context-fixture', enumerable: false });
      return writer;
    } },
    { name: 'fixed writer and getter', getWriter: () => makeWriter(), writer: makeWriter() },
    { name: 'mismatched thread', getWriter: () => makeWriter('codex', 'other-thread'), meta: { provider: 'codex', threadId: 'requested-thread' } },
  ];

  for (const fixture of cases) {
    let fetchCount = 0;
    const response = await exchange([{
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'cockpit_question_status',
        arguments: { questionId: 'question-fixture' },
        ...(fixture.meta ? { _meta: fixture.meta } : {}),
      },
    }], {
      homeDir: 'C:\\temporary-cockpit',
      environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
      getWriter: fixture.getWriter,
      ...(fixture.writer ? { writer: fixture.writer } : {}),
      ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
      fetchImpl: async () => { fetchCount += 1; return new Response('{}', { status: 200 }); },
    });
    assert.equal(response[0].result.isError, true, fixture.name);
    assert.equal(fetchCount, 0, fixture.name);
  }
});

test('同じbindingの並行answer-pollはそれぞれ一度のgetter結果だけを使う', async () => {
  const writer = makeWriter();
  let getterCalls = 0;
  const sent = [];
  const responses = await exchange([1, 2].map((id) => ({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'cockpit_answer_poll', arguments: { questionId: 'question-fixture' } },
  })), {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    getWriter() { getterCalls += 1; return writer; },
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      sent.push(JSON.parse(init.body).writer);
      return new Response(JSON.stringify({ questionId: 'question-fixture', deliveryState: 'available' }), { status: 200 });
    },
  });

  assert.equal(responses.length, 2);
  assert.equal(getterCalls, 2);
  assert.deepEqual(sent, [writer, writer]);
});

test('時間切れの add_pr、skip_review、plan は結果未確認の文を isError で返す', async () => {
  const calls = [
    ['cockpit_set_tasks', { tasks: [] }],
    ['cockpit_add_pr', { url: 'https://github.com/example/project/pull/45' }],
    ['cockpit_skip_review', {
      owner: 'example', repo: 'project', number: 45, headRefOid: 'a'.repeat(40), reason: '記録する理由',
    }],
  ];

  for (const [index, [name, argumentsValue]] of calls.entries()) {
    let ensureCalls = 0;
    let fetchCount = 0;
    let refreshCalls = 0;
    const responses = await exchange([{
      jsonrpc: '2.0', id: index + 1, method: 'tools/call',
      params: { name, arguments: argumentsValue },
    }], {
      homeDir: 'C:\\temporary-cockpit',
      environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
      writer: makeWriter(),
      refreshWriter: async () => { refreshCalls += 1; },
      deadline: Date.now() + 100,
      ensureServerRunning: async () => {
        ensureCalls += 1;
        return { port: 49124, secret: 'test-secret' };
      },
      fetchImpl: async (_url, init) => {
        fetchCount += 1;
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });

    assert.equal(responses[0].result.isError, true, name);
    assert.equal(responses[0].result.content[0].text, TIMEOUT_MESSAGE, name);
    assert.equal(fetchCount, 1, name);
    assert.equal(ensureCalls, 1, name);
    assert.equal(refreshCalls, 0, name);
  }
});

test('writerの明示的な403だけは一度更新してMCP書き込みを再送する', async () => {
  let writer = makeWriter();
  writer.contextId = 'context-old';
  const refreshedWriter = { ...writer, contextId: 'context-new', executionId: 'execution-new' };
  const requests = [];
  let refreshCalls = 0;
  const responses = await exchange([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_set_tasks', arguments: { tasks: [] } },
  }], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    getWriter: () => writer,
    refreshWriter: async (_deadline, { discard }) => {
      assert.equal(discard, true);
      refreshCalls += 1;
      writer = refreshedWriter;
    },
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body).writer);
      return new Response(JSON.stringify({ tasks: [] }), { status: requests.length === 1 ? 403 : 200 });
    },
  });

  assert.equal(responses[0].result.isError, undefined);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(requests.map((request) => request.contextId), ['context-old', 'context-new']);
});

test('403後にwriter更新して再送した要求が結果不明なら再更新も再送もしない', async () => {
  let writer = makeWriter();
  const refreshedWriter = { ...writer, contextId: 'context-new', executionId: 'execution-new' };
  const requests = [];
  let refreshCalls = 0;
  const unknownMessage = '処理結果を確認できません。同じ書き込みを繰り返す前に、ダッシュボードで反映状態を確認してください。';
  const responses = await exchange([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_set_tasks', arguments: { tasks: [] } },
  }], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    getWriter: () => writer,
    refreshWriter: async (_deadline, { discard }) => {
      assert.equal(discard, true);
      refreshCalls += 1;
      writer = refreshedWriter;
    },
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body).writer);
      if (requests.length === 1) return new Response('{}', { status: 403 });
      throw Object.freeze(Object.assign(new Error('private response loss'), {
        requestStarted: false,
        code: 'DEADLINE_TIMEOUT',
      }));
    },
  });

  assert.equal(responses[0].result.isError, true);
  assert.equal(responses[0].result.content[0].text, unknownMessage);
  assert.equal(refreshCalls, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.contextId), ['context-fixture', 'context-new']);
});
