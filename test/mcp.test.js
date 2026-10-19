const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const {
  startMcpServer,
  SERVER_VERSION,
  MCP_GITHUB_TIMEOUT_MS,
  TIMEOUT_MESSAGE,
  UNREACHABLE_MESSAGE,
  callTool,
} = require('../src/mcp/server');

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
    ppid: 321,
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/diagnostics')) return new Response('{}', { status: 202 });
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ tasks: [{ title: 'テストを書く', state: 'doing' }] }), { status: 200 });
    },
  });
  assert.equal(responses.length, 3);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].result.serverInfo.name, 'agent-cockpit');
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), [
    'cockpit_set_tasks', 'cockpit_add_decision', 'cockpit_report_launch', 'cockpit_update_decision', 'cockpit_add_pr', 'cockpit_skip_review',
  ]);
  const setTasksTool = responses[1].result.tools.find((tool) => tool.name === 'cockpit_set_tasks');
  const criteriaSchema = setTasksTool.inputSchema.properties.tasks.items.properties.criteria.items;
  assert.equal(criteriaSchema.properties.doing.type, 'boolean');
  assert.ok(!criteriaSchema.required.includes('doing'));
  assert.match(setTasksTool.description, /met が false で doing が true なら作業中/);
  assert.equal(responses[2].id, 3);
  assert.match(responses[2].result.content[0].text, /テストを書く \(doing\)/);
  assert.equal(sent.url, 'http://127.0.0.1:49124/api/sessions/mcp-session/plan');
  assert.equal(sent.headers['x-cockpit-secret'], 'test-secret');
  assert.deepEqual(
    [sent.body.kind, sent.body.ppid, sent.body.claudeCodeSessionId],
    ['tasks', 321, 'mcp-session'],
  );
  assert.ok(!JSON.stringify(sent).includes('must-not-be-sent'));
  assert.ok(!JSON.stringify(sent).includes('also-must-not-be-sent'));
  assert.ok(!JSON.stringify(responses).includes('also-must-not-be-sent'));
  assert.ok(!JSON.stringify(responses).includes('test-secret'));
});

test('MCP stdio の診断送信はプロセスの version と起動時に読んだ commit を付け、読めない commit は省く', async () => {
  const collectDiagnostics = async readSourceCommit => {
    const diagnostics = [];
    let resolveDiagnostics;
    const diagnosticsSent = new Promise(resolve => { resolveDiagnostics = resolve; });
    const responses = await exchange([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'cockpit_set_tasks', arguments: { tasks: [] } } },
    ], {
      homeDir: 'C:\\temporary-cockpit',
      environment: { CLAUDE_CODE_SESSION_ID: 'mcp-diagnostic-version' },
      readSourceCommit,
      ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
      fetchImpl: async (url, init) => {
        if (url.endsWith('/api/diagnostics')) {
          diagnostics.push(JSON.parse(init.body).entries[0].data);
          if (diagnostics.length === 2) resolveDiagnostics();
          return new Response('{}', { status: 202 });
        }
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      },
    });
    await diagnosticsSent;
    assert.equal(responses[1].id, 2);
    return diagnostics;
  };

  let commitReads = 0;
  const commit = 'b'.repeat(40);
  const withCommit = await collectDiagnostics(async () => { commitReads += 1; return commit; });
  assert.equal(commitReads, 1);
  assert.deepEqual(withCommit, [
    { tool: 'cockpit_set_tasks', phase: 'attempt', version: SERVER_VERSION, commit },
    { tool: 'cockpit_set_tasks', phase: 'result', ok: true, status: 200, version: SERVER_VERSION, commit },
  ]);

  let readBeforeWrite = 0;
  await exchange([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }], {
    readSourceCommit: async () => { readBeforeWrite += 1; return commit; },
  });
  assert.equal(readBeforeWrite, 1);

  const withoutCommit = await collectDiagnostics(async () => null);
  assert.deepEqual(withoutCommit, [
    { tool: 'cockpit_set_tasks', phase: 'attempt', version: SERVER_VERSION },
    { tool: 'cockpit_set_tasks', phase: 'result', ok: true, status: 200, version: SERVER_VERSION },
  ]);
});

test('cockpit_add_pr は PR URL を秘密値付きで常駐サーバーへ登録する', async () => {
  let sent = null;
  const responses = await exchange([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_add_pr', arguments: { url: 'https://github.com/example/project/pull/45' } },
  }], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    ppid: 321,
    cwd: 'D:\\project\\.claude\\worktrees\\mcp-session',
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/diagnostics')) return new Response('{}', { status: 202 });
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ owner: 'example', repo: 'project', number: 45, url: 'https://github.com/example/project/pull/45' }), { status: 200 });
    },
  });
  assert.equal(responses[0].result.isError, undefined);
  assert.match(responses[0].result.content[0].text, /PR #45/);
  assert.equal(sent.url, 'http://127.0.0.1:49124/api/sessions/mcp-session/prs');
  assert.equal(sent.headers['x-cockpit-secret'], 'test-secret');
  assert.equal(sent.headers.origin, undefined);
  assert.deepEqual([sent.body.kind, sent.body.url, sent.body.ppid], [
    'add_pr', 'https://github.com/example/project/pull/45', 321,
  ]);
  assert.equal(sent.body.claudeCodeSessionId, 'mcp-session');
});

test('cockpit_skip_review は理由と指定 head を秘密値付きで常駐サーバーへ記録する', async () => {
  let sent = null;
  const headRefOid = 'a'.repeat(40);
  const responses = await exchange([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_skip_review', arguments: {
      owner: 'example', repo: 'project', number: 45, headRefOid, reason: '変更が説明文だけのため',
    } },
  }], {
    homeDir: 'C:\\temporary-cockpit',
    environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    ppid: 321,
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/diagnostics')) return new Response('{}', { status: 202 });
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ number: 45, owner: 'example', repo: 'project', headRefOid }), { status: 200 });
    },
  });

  assert.equal(responses[0].result.isError, undefined);
  assert.match(responses[0].result.content[0].text, /クロスレビュー不要として記録しました/);
  assert.equal(sent.url, 'http://127.0.0.1:49124/api/sessions/mcp-session/prs');
  assert.equal(sent.headers['x-cockpit-secret'], 'test-secret');
  assert.equal(sent.headers.origin, undefined);
  assert.deepEqual([
    sent.body.kind, sent.body.owner, sent.body.repo, sent.body.number,
    sent.body.headRefOid, sent.body.reason, sent.body.ppid, sent.body.claudeCodeSessionId,
  ], ['skip_review', 'example', 'project', 45, headRefOid, '変更が説明文だけのため', 321, 'mcp-session']);
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
    now: () => nowValue,
    ensureServerRunning: async ({ deadline }) => {
      observedDeadline = deadline;
      return { port: 49124, secret: 'test-secret' };
    },
    fetchImpl: async (_url, init) => {
      if (_url.endsWith('/api/diagnostics')) return new Response('{}', { status: 202 });
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
    environment: {},
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
        ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
        readServerInfo: async () => ({ port: 49125, secret: 'updated-secret' }),
        fetchImpl: async url => {
          if (!url.endsWith('/api/diagnostics')) fetchCount += 1;
          return new Response('{}', { status });
        },
      });
      assert.equal(responses[0].result.isError, true, `${name} with HTTP ${status}`);
      assert.equal(responses[0].result.content[0].text, UNREACHABLE_MESSAGE, `${name} with HTTP ${status}`);
      assert.equal(fetchCount, status === 401 ? 2 : 1, `${name} with HTTP ${status}`);
    }
  }
});

test('委譲した thread への MCP 書き込みは記録不要と返し、それ以外の 403 は親 ID があっても未登録の文を返す', async () => {
  const delegatedMessage = 'Claude のセッションから委譲された実行なので、Agent Cockpit には記録しない。記録は委譲元の Claude のセッションが行うので、このツールを呼ばなくてよい。';
  const unregisteredMessage = 'Codex のフックが届いていないため記録できなかった。未登録または終了済みのセッションです。';
  const calls = [
    ['cockpit_set_tasks', { tasks: [] }],
    ['cockpit_add_pr', { url: 'https://github.com/example/project/pull/45' }],
    ['cockpit_skip_review', {
      owner: 'example', repo: 'project', number: 45, headRefOid: 'a'.repeat(40), reason: '記録しない理由',
    }],
  ];

  for (const [name, argumentsValue] of calls) {
    for (const { error, expected, isError } of [
      { error: 'Codex session delegated', expected: delegatedMessage, isError: undefined },
      { error: 'Codex session unavailable', expected: unregisteredMessage, isError: true },
    ]) {
      const result = await callTool(name, argumentsValue, {
        homeDir: 'C:\\temporary-cockpit',
        environment: { CLAUDE_CODE_SESSION_ID: 'claude-parent' },
        codexSessionId: 'codex-thread',
        ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
        fetchImpl: async url => url.endsWith('/api/diagnostics') ? new Response('{}', { status: 202 })
          : new Response(JSON.stringify({ error }), { status: 403 }),
      });
      assert.equal(result.isError, isError, name);
      assert.equal(result.content[0].text, expected, name);
    }
  }
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
    const responses = await exchange([{
      jsonrpc: '2.0', id: index + 1, method: 'tools/call',
      params: { name, arguments: argumentsValue },
    }], {
      homeDir: 'C:\\temporary-cockpit',
      environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
      deadline: Date.now() + 100,
      ensureServerRunning: async () => {
        ensureCalls += 1;
        return { port: 49124, secret: 'test-secret' };
      },
      fetchImpl: async (_url, init) => {
        if (_url.endsWith('/api/diagnostics')) return new Response('{}', { status: 202 });
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
  }
});


test('cockpit_set_tasks の成功文は登録された題を知らせる', async () => {
  const responses = await exchange([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_set_tasks', arguments: { tasks: [{ title: '別の題', state: 'todo', criteria: [] }] } },
  }], {
    homeDir: 'C:\\temporary-cockpit', environment: { CLAUDE_CODE_SESSION_ID: 'mcp-session' },
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async () => new Response(JSON.stringify({ tasks: [{ title: '別の題', state: 'todo' }] }), { status: 200 }),
  });
  assert.match(responses[0].result.content[0].text, /タスクを記録しました: 別の題/);
});

test('Codex の MCP ツール説明は従来どおり一覧全体の登録を案内する', async () => {
  const responses = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-mcp-client' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  const tool = responses[1].result.tools.find(tool => tool.name === 'cockpit_set_tasks');
  assert.match(tool.description, /一覧全体を新しい内容に置き換え/);
  assert.doesNotMatch(tool.description, /アプリのタスク一覧/);
});
