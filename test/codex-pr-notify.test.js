const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runHook } = require('../src/hooks/event');
const { runAnswerHook } = require('../src/hooks/answer');
const { handleRequest } = require('../src/mcp/server');
const { DashboardState } = require('../src/server/state');
const { PullRequestTracker } = require('../src/server/pull-requests');
const { jsonBody, request, startTestServer, hookHeaders } = require('./support/server');
const { temporaryDirectory } = require('./support/temp');

async function cockpit(t, options = {}) {
  const server = await startTestServer(t, options);
  const post = (url, body) => request(server.info.port, {
    method: 'POST', path: url, headers: hookHeaders(server.info.secret), body: JSON.stringify(body),
  });
  const event = (sessionId, provider, hookEventName, fields = {}) => post('/api/events', {
    session_id: sessionId, provider, hook_event_name: hookEventName, cwd: process.cwd(), hookAt: Date.now(), ...fields,
  });
  const snapshot = async () => jsonBody(await request(server.info.port, { path: '/api/state' }));
  const addPrWithCodexMcp = async (sessionId, url) => {
    await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-mcp-client' } } });
    return handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'cockpit_add_pr', arguments: { url }, _meta: { sessionId, threadId: sessionId } },
    }, { homeDir: server.homeDir });
  };
  return { ...server, post, event, snapshot, addPrWithCodexMcp };
}

const codexHookOptions = (homeDir) => ({ provider: 'codex', homeDir, findCodexParentPid: async () => null });

test('Codex の Bash で作成した PR を登録し、別コマンドの出力 URL は登録しない', async (t) => {
  const c = await cockpit(t);
  const options = codexHookOptions(c.homeDir);
  await runHook({ session_id: 'codex-gh-create', hook_event_name: 'SessionStart', cwd: process.cwd() }, options);
  const createInput = {
    session_id: 'codex-gh-create', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'gh-create',
    cwd: process.cwd(), tool_input: { command: 'gh pr create' },
  };
  await runHook(createInput, options);
  assert.equal(c.runtime.state.wasPullRequestCreate('codex-gh-create', 'gh-create'), true);
  await runHook({ ...createInput, hook_event_name: 'PostToolUse',
    tool_response: 'https://github.com/example/project/pull/71',
  }, options);
  assert.equal(c.runtime.state.pullRequestRegistrations()[0].provider, 'codex');

  await runHook({ ...createInput, hook_event_name: 'PostToolUse', tool_use_id: 'other-command',
    tool_input: { command: 'git status' }, tool_response: 'https://github.com/example/project/pull/72',
  }, options);
  assert.deepEqual(c.runtime.state.pullRequestRegistrations().map((record) => record.number), [71]);
});

test('同じ PR の Claude と Codex の起点を木と「前回見てから」に渡し、Codex MCP 登録を保存する', async (t) => {
  const state = new DashboardState();
  const tracker = new PullRequestTracker({ state });
  tracker.refreshRepo = async () => null;
  const start = Date.now();
  const c = await cockpit(t, {
    state,
    pullRequestTracker: tracker,
    away: { snapshot: () => ({ enabled: true, since: new Date(start).toISOString(), periods: [{ start: start - 30_000, end: null }] }) },
  });
  await c.event('claude-pr-source', 'claude', 'SessionStart');
  await c.event('codex-pr-source', 'codex', 'SessionStart');
  const product = c.runtime.state.productForSession('claude-pr-source');
  c.runtime.state.setProductSeen(product.key, Date.now() - 10_000);
  c.runtime.state.setTasks('claude-pr-source', [{ title: 'Claude の完了', state: 'done', criteria: [] }], Date.now() - 500);
  c.runtime.state.setTasks('codex-pr-source', [{ title: 'Codex の完了', state: 'done', criteria: [] }], Date.now() - 400);
  c.runtime.state.registerPullRequest('claude-pr-source', { url: 'https://github.com/example/project/pull/73' }, { product }, Date.now() - 300);
  const mcp = await c.addPrWithCodexMcp('codex-pr-source', 'https://github.com/example/project/pull/73');
  assert.equal(mcp.result.isError, undefined);
  assert.equal(c.runtime.state.pullRequestRegistrationForSession('codex-pr-source', 'example', 'project', 73).provider, 'codex');

  const tree = {
    number: 73, title: '起点の確認', url: 'https://github.com/example/project/pull/73',
    headRefName: 'feature/source', baseRefName: 'main', headRefOid: 'a'.repeat(40), canMerge: false, children: [],
  };
  tracker.productViews.set('test-product', {
    owner: 'example', repo: 'project', product, mergeMethods: [], autoDeleteBranch: false,
    checkedAt: null, fetchedAt: null, error: null, registeredCount: 2, openCount: 1,
    mergeableCount: 0, trees: [tree], merged: [], mergeHistory: [], reservations: [], lastMethod: null,
  });

  await c.runtime.state.flushPersistence();
  const restored = await DashboardState.load(c.homeDir);
  assert.equal(restored.pullRequestRegistrationForSession('codex-pr-source', 'example', 'project', 73).provider, 'codex');

  const snapshot = await c.snapshot();
  assert.deepEqual(snapshot.pullRequests[0].trees[0].providers, ['claude', 'codex']);
  const items = snapshot.sinceSeen.flatMap((entry) => entry.items);
  assert.equal(items.find((item) => item.text === 'タスク「Claude の完了」が完了した').provider, 'claude');
  assert.equal(items.find((item) => item.text === 'タスク「Codex の完了」が完了した').provider, 'codex');
  const created = items.find((item) => item.type === 'pull-request-summary');
  assert.deepEqual(created.providers, ['claude', 'codex']);
});

test('Codex の PostToolUse 回答フックは PR 通知を受け取る', async (t) => {
  const c = await cockpit(t);
  await c.event('codex-notification', 'codex', 'SessionStart');
  c.runtime.answerDelivery.notifySessions(['codex-notification'], 'PR #74 の衝突を解消しました。');
  const result = await runAnswerHook({ session_id: 'codex-notification', hook_event_name: 'PostToolUse', tool_name: 'exec_command' }, {
    provider: 'codex', homeDir: c.homeDir,
    fetchImpl: async (url, init = {}) => {
      const response = await request(c.info.port, {
        method: init.method, path: new URL(url).pathname, headers: init.headers, body: init.body || '',
      });
      return { ok: response.status === 200, status: response.status, json: async () => jsonBody(response) };
    },
  });
  assert.match(result.output.hookSpecificOutput.additionalContext, /PR #74 の衝突を解消しました。/);
});

test('provider のない保存済み PR は Claude として復元する', async (t) => {
  const { directory } = temporaryDirectory(t, 'agent-cockpit-codex-pr-legacy-');
  const state = new DashboardState({ homeDir: directory });
  state.registerPullRequest('legacy-pr', { url: 'https://github.com/example/project/pull/75' });
  await state.flushPersistence();
  const saved = state.serializeStore();
  delete saved.prs[0].provider;
  await fs.writeFile(path.join(directory, 'store.json'), JSON.stringify(saved));

  const restored = await DashboardState.load(directory);
  assert.equal(restored.pullRequestRegistrations()[0].provider, 'claude');
});
