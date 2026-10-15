const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startServer: startRealServer } = require('../src/server/server');
const startServer = options => startRealServer({ readSourceCommit: async () => null, readSourceState: () => 'unknown', ...options });
const { request, jsonBody, startTestServer, uiHeaders } = require('./support/server');
const { runHook, runHookText } = require('../src/hooks/event');
const { callTool } = require('../src/mcp/server');
const { appendPendingHook, MAX_HOOK_PENDING_BYTES } = require('../src/client/hooks-pending');
const { MAX_DIAGNOSTICS_PER_EVENT, MAX_DIAGNOSTICS_BODY_BYTES } = require('../src/client/diagnostic-events');
const { temporaryHome } = require('./support/temp');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('常駐サーバーの起動時に退避済みのフック失敗を取り込む', async t => {
  const { homeDir, claudeHome } = temporaryHome(t);
  await appendPendingHook(homeDir, { msg: 'hook.delivery', data: { failure: 'timeout', secret: 'private' } });
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());
  assert.deepEqual((await read(runtime)).filter(entry => entry.tag === 'hook').map(entry => entry.data), [{ failure: 'timeout' }]);
});

test('フックの PID 照会の失敗と時間切れはエラー文を送らず分類する', async t => {
  const { runtime, info } = await startTestServer(t);
  for (const [result, findCodexParentPid] of [['failed', async () => { throw new Error('private-command stderr'); }],
    ['timeout', () => new Promise(() => {})], ['missing', async () => null]]) {
    await runHook({ session_id: `pid-${result}`, hook_event_name: 'SessionStart' }, {
      homeDir: runtime.homeDir, provider: 'codex', initialInfo: info, findCodexParentPid, codexParentTimeoutMs: 5,
    });
    assert.equal((await read(runtime)).filter(entry => entry.msg === 'hook.pid').at(-1).data.result, result);
  }
  assert.doesNotMatch(JSON.stringify((await read(runtime)).filter(entry => entry.tag === 'hook')), /private|stderr/);
});

test('フックが常駐サーバーを起動した場合は起動した段を送る', async t => {
  const { homeDir, claudeHome } = temporaryHome(t);
  let runtime;
  t.after(async () => { if (runtime) await runtime.close(); });
  await runHook({ session_id: 'hook-launch', hook_event_name: 'SessionStart' }, {
    homeDir, startServer: async () => { runtime = await startServer({ homeDir, claudeHome, port: 0 }); },
  });
  assert.deepEqual((await read(runtime)).find(entry => entry.msg === 'hook.server').data, { started: true });
});

test('診断の POST は送り手を認証で固定し、未知の識別子と鍵と自由文の値を捨てる', async t => {
  const { runtime, info } = await startTestServer(t);
  const entries = [{ msg: 'mcp.write', tag: 'server', level: 'mark', data: { tool: 'cockpit_set_tasks', phase: 'result', ok: true, status: 200,
    secret: info.secret, arguments: 'private', failure: 'private' } }, { msg: 'server.start', data: { pid: 123 } },
    { msg: 'web.failed', data: { path: '/api/state' } }];
  assert.equal((await uiPost(info, '/api/diagnostics', { entries }, { 'x-cockpit-secret': info.secret })).status, 202);
  const saved = (await read(runtime)).filter(entry => entry.tag === 'mcp');
  assert.deepEqual(saved.map(entry => entry.data), [{ tool: 'cockpit_set_tasks', phase: 'result', ok: true, status: 200 }]);
  assert.equal(saved[0].level, 'info');
  await uiPost(info, '/api/diagnostics', { entries: [{ msg: 'web.failed', data: { operation: 'save', path: '/api/decisions/:id/answer', status: 500, message: 'private' } },
    { msg: 'web.failed', data: { path: '/private/path', status: 'private' } }, entries[0]] });
  assert.deepEqual((await read(runtime)).filter(entry => entry.tag === 'web').map(entry => entry.data),
    [{ operation: 'save', path: '/api/decisions/:id/answer', status: 500 }, {}]);
  assert.doesNotMatch(JSON.stringify(await read(runtime)), /private/);
});

test('診断の POST は秘密値と Origin と上限に違反する記録を採らない', async t => {
  const { runtime, info } = await startTestServer(t);
  const body = { entries: [{ msg: 'web.failed', data: { path: '/api/state', status: 500 } }] };
  for (const [headers, status] of [[{}, 401], [uiHeaders(info), 403], [uiHeaders(info, 'https://example.com'), 403],
    [{ 'x-cockpit-secret': info.secret, origin: `http://127.0.0.1:${info.port}` }, 403]]) {
    assert.equal((await uiPost(info, '/api/diagnostics', body, headers)).status, status);
  }
  assert.equal((await uiPost(info, '/api/diagnostics', { entries: Array(MAX_DIAGNOSTICS_PER_EVENT + 1).fill(body.entries[0]) })).status, 400);
  assert.equal((await uiPost(info, '/api/diagnostics', { entries: [], extra: 'x'.repeat(MAX_DIAGNOSTICS_BODY_BYTES) })).status, 413);
  assert.equal((await read(runtime)).filter(entry => ['mcp', 'web'].includes(entry.tag)).length, 0);
});

test('フックの入口は解釈と PID 照会と起動の段を送り、成功時には退避を作らない', async t => {
  const { runtime, info } = await startTestServer(t);
  await runHook({ session_id: 'diagnostic-hook', hook_event_name: 'SessionStart', cwd: 'private-path', tool_input: 'private-input' }, {
    homeDir: runtime.homeDir, provider: 'codex', findCodexParentPid: async () => 123, initialInfo: info,
  });
  const entries = (await read(runtime)).filter(entry => entry.tag === 'hook');
  assert.equal(entries.find(entry => entry.msg === 'hook.pid').data.result, 'found');
  assert.equal(typeof entries.find(entry => entry.msg === 'hook.pid').data.durationMs, 'number');
  assert.deepEqual(entries.find(entry => entry.msg === 'hook.server').data, { started: false });
  assert.deepEqual(entries.find(entry => entry.msg === 'hook.input').data, { result: 'parsed' });
  assert.doesNotMatch(JSON.stringify(entries), /private/);
  await assert.rejects(fs.stat(path.join(runtime.homeDir, 'diagnostics/hooks-pending.jsonl')), { code: 'ENOENT' });
  await runHookText('private-invalid-json', { homeDir: runtime.homeDir, initialInfo: info });
  assert.equal((await read(runtime)).filter(entry => entry.msg === 'hook.input').at(-1).data.result, 'invalid');
});

test('フックの HTTP 受付は添付の件数を制限し、hook 以外の記録を捨てる', async t => {
  const { runtime, info } = await startTestServer(t);
  await uiPost(info, '/api/events', { session_id: 'diagnostics-cap', hook_event_name: 'Stop', diagnostics: [
    { msg: 'hook.input', data: { result: 'parsed', secret: info.secret, input: 'private' } },
    { msg: 'mcp.write', data: { tool: 'cockpit_set_tasks' } },
    ...Array(MAX_DIAGNOSTICS_PER_EVENT).fill({ msg: 'hook.server', data: { started: false } }),
  ] }, { 'x-cockpit-secret': info.secret });
  await runtime.diagnostics.flush();
  const allEntries = await read(runtime);
  const entries = allEntries.filter(entry => entry.tag === 'hook');
  assert.deepEqual(entries.filter(entry => entry.msg === 'hook.input').map(entry => entry.data), [{ result: 'parsed' }]);
  assert.deepEqual(entries.filter(entry => entry.msg === 'hook.server').map(entry => entry.data), [
    { started: false },
  ]);
  assert.deepEqual(entries.filter(entry => entry.msg === 'diagnostics.repeated').map(entry => repeatedData(entry.data)), [
    { msg: 'hook.server', count: MAX_DIAGNOSTICS_PER_EVENT - 3, data: { started: false } },
  ]);
  assert.equal(allEntries.some(entry => entry.msg === 'mcp.write'), false);
});

test('届かないフックは安全な一行だけ退避し、走査は壊れた行を捨てて一度だけ取り込む', async t => {
  const { runtime } = await startTestServer(t);
  await runHook({ session_id: 'private-session', hook_event_name: 'Stop', cwd: 'private-path' }, {
    homeDir: runtime.homeDir, ensureServerRunning: async () => null,
  });
  const file = path.join(runtime.homeDir, 'diagnostics/hooks-pending.jsonl');
  const text = await fs.readFile(file, 'utf8');
  const pending = JSON.parse(text);
  assert.match(pending.data.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(pending, { msg: 'hook.delivery', data: { failure: 'unreachable', at: pending.data.at, event: 'Stop',
    ensureMs: pending.data.ensureMs, postMs: pending.data.postMs, sinceHookMs: pending.data.sinceHookMs } });
  await fs.appendFile(file, 'broken\n' + JSON.stringify({ msg: 'server.start', data: { secret: 'private' } }) + '\n');
  await Promise.all([runtime.refreshSessionFiles(), appendPendingHook(runtime.homeDir, { msg: 'hook.input', data: { result: 'invalid', input: 'private' } })]);
  await runtime.refreshSessionFiles();
  await runtime.refreshSessionFiles();
  const imported = (await read(runtime)).filter(entry => entry.tag === 'hook');
  assert.deepEqual(imported.map(entry => entry.msg).sort(), ['hook.delivery', 'hook.input']);
  assert.equal(imported.find(entry => entry.msg === 'hook.delivery').data.at, pending.data.at);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('期限切れのフックは、常駐サーバーの確認と送信のそれぞれにかかった時間を退避する', async t => {
  const { runtime } = await startTestServer(t);
  const ensureDelayMs = 60;
  const hookAt = Date.now();
  await runHook({ session_id: 'slow-session', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'read' }, {
    homeDir: runtime.homeDir, now: hookAt, deadline: hookAt + 300,
    ensureServerRunning: async () => { await new Promise(resolve => setTimeout(resolve, ensureDelayMs)); return runtime.info; },
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason))),
  });
  const pending = JSON.parse(await fs.readFile(path.join(runtime.homeDir, 'diagnostics/hooks-pending.jsonl'), 'utf8'));
  assert.equal(pending.data.failure, 'timeout');
  assert.equal(pending.data.event, 'PostToolUse');
  assert.ok(pending.data.ensureMs >= ensureDelayMs - 5, `ensureMs=${pending.data.ensureMs}`);
  assert.ok(pending.data.postMs > 0);
  assert.ok(pending.data.sinceHookMs >= pending.data.ensureMs + pending.data.postMs - 5);
});

test('退避が上限を超えていると届かないフックは追記せず正常に終わる', async t => {
  const { runtime } = await startTestServer(t);
  const file = path.join(runtime.homeDir, 'diagnostics/hooks-pending.jsonl');
  await fs.writeFile(file, 'x'.repeat(MAX_HOOK_PENDING_BYTES + 1));
  assert.equal((await runHook({ session_id: 'pending-full', hook_event_name: 'Stop' }, {
    homeDir: runtime.homeDir, ensureServerRunning: async () => null,
  })).exitCode, 0);
  assert.equal((await fs.stat(file)).size, MAX_HOOK_PENDING_BYTES + 1);
});

test('記録しない設定とエラーのみの設定では、届かないフックを退避しない', async t => {
  const { runtime } = await startTestServer(t);
  const file = path.join(runtime.homeDir, 'diagnostics/hooks-pending.jsonl');
  for (const diagnosticsLevel of ['silent', 'error']) {
    runtime.state.patchDisplayPreferences({ diagnosticsLevel });
    await runtime.state.flushStoreWrite();
    await runHook({ session_id: `pending-${diagnosticsLevel}`, hook_event_name: 'Stop' }, {
      homeDir: runtime.homeDir, ensureServerRunning: async () => null,
    });
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  }
});

test('MCP の入口は書き込みの試行と HTTP の結果を記録し、引数の本文を含めない', async t => {
  const { runtime, info } = await startTestServer(t);
  const pending = [];
  await callTool('cockpit_set_tasks', { tasks: [{ title: 'private-task', state: 'doing', criteria: [] }] }, {
    homeDir: runtime.homeDir, environment: { CLAUDE_CODE_SESSION_ID: 'mcp-diagnostic' },
    ensureServerRunning: async () => info,
    fetchImpl: (url, init) => { const operation = fetch(url, init); pending.push(operation); return operation; },
  });
  await Promise.all(pending);
  const entries = (await read(runtime)).filter(entry => entry.tag === 'mcp');
  assert.deepEqual(entries.map(entry => entry.data), [{ tool: 'cockpit_set_tasks', phase: 'attempt' },
    { tool: 'cockpit_set_tasks', phase: 'result', ok: true, status: 200 }]);
  assert.doesNotMatch(JSON.stringify(entries), /private/);
});

test('MCP の診断送信が失敗しても書き込みは完了し、診断を再送しない', async t => {
  const { runtime, info } = await startTestServer(t);
  const diagnostics = [];
  const result = await callTool('cockpit_set_tasks', { tasks: [] }, {
    homeDir: runtime.homeDir, environment: { CLAUDE_CODE_SESSION_ID: 'diagnostic-failure' },
    ensureServerRunning: async () => info,
    fetchImpl: (url, init) => {
      if (!url.endsWith('/api/diagnostics')) return fetch(url, init);
      diagnostics.push(JSON.parse(init.body));
      return Promise.reject(new Error('private-message'));
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(diagnostics.map(body => body.entries[0].data.phase), ['attempt', 'result']);
  assert.equal((await read(runtime)).filter(entry => entry.tag === 'mcp').length, 0);
});

const uiPost = (info, route, body, headers = uiHeaders(info, `http://127.0.0.1:${info.port}`)) => request(info.port,
  { method: 'POST', path: route, headers, body: JSON.stringify(body) });
const repeatedData = ({ since, ...data }) => {
  assert.match(since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  return data;
};
const read = async (runtime, run = runtime.diagnostics.run) => jsonBody(await request(runtime.info.port,
  { path: `/api/diagnostics?run=${encodeURIComponent(run)}` })).entries;

test('期間内の同じ記録は最初の 1 件と期間終了時の件数を残す', async t => {
  const { runtime } = await startTestServer(t, { diagnosticsOptions: { repeatWindowMs: 50, repeatFlushIntervalMs: 5 } });
  for (let index = 0; index < 3; index += 1) {
    await runtime.diagnostics.record('warn', 'web', 'web.failed', { path: '/api/health', status: 500 });
  }
  assert.equal((await read(runtime)).filter(entry => entry.msg === 'web.failed').length, 1);
  await delay(80);
  const entries = await read(runtime);
  const repeated = entries.find(entry => entry.msg === 'diagnostics.repeated');
  assert.deepEqual({ level: repeated.level, tag: repeated.tag, data: repeatedData(repeated.data) }, {
    level: 'warn', tag: 'web', data: { msg: 'web.failed', count: 2, data: { path: '/api/health', status: 500 } },
  });
  await runtime.diagnostics.record('warn', 'web', 'web.failed', { path: '/api/health', status: 500 });
  const nextPeriod = await read(runtime);
  assert.equal(nextPeriod.filter(entry => entry.msg === 'web.failed').length, 2);
  assert.equal(nextPeriod.filter(entry => entry.msg === 'diagnostics.repeated').length, 1);
});

test('data が異なる記録はまとめない', async t => {
  const { runtime } = await startTestServer(t, { diagnosticsOptions: { repeatWindowMs: 60_000 } });
  await runtime.diagnostics.record('warn', 'web', 'web.failed', { path: '/api/health', status: 500 });
  await runtime.diagnostics.record('warn', 'web', 'web.failed', { path: '/api/health', status: 503 });
  await runtime.diagnostics.flush();
  const entries = await read(runtime);
  assert.equal(entries.filter(entry => entry.msg === 'web.failed').length, 2);
  assert.equal(entries.filter(entry => entry.msg === 'diagnostics.repeated').length, 0);
});

test('mark は同じ内容でもまとめない', async t => {
  const { runtime } = await startTestServer(t, { diagnosticsOptions: { repeatWindowMs: 60_000 } });
  await runtime.diagnostics.record('mark', 'server', 'server.stop', { pid: process.pid });
  await runtime.diagnostics.record('mark', 'server', 'server.stop', { pid: process.pid });
  assert.equal((await read(runtime)).filter(entry => entry.msg === 'server.stop').length, 2);
});

test('flush は期限前の繰り返し件数を書き出す', async t => {
  const { runtime } = await startTestServer(t, { diagnosticsOptions: { repeatWindowMs: 60_000 } });
  await runtime.diagnostics.record('error', 'web', 'web.failed', { path: '/api/health', status: 500 });
  await runtime.diagnostics.record('error', 'web', 'web.failed', { path: '/api/health', status: 500 });
  await runtime.diagnostics.flush();
  const repeated = (await read(runtime)).find(entry => entry.msg === 'diagnostics.repeated');
  assert.deepEqual({ level: repeated.level, tag: repeated.tag, data: repeatedData(repeated.data) }, {
    level: 'error', tag: 'web', data: { msg: 'web.failed', count: 1, data: { path: '/api/health', status: 500 } },
  });
});

test('現在の起動を削除すると、まとめていた件数を捨て、削除後の最初の 1 件を書く', async t => {
  const { runtime } = await startTestServer(t, { diagnosticsOptions: { repeatWindowMs: 60_000 } });
  for (let index = 0; index < 2; index += 1) {
    await runtime.diagnostics.record('warn', 'web', 'web.failed', { path: '/api/health', status: 500 });
  }
  await runtime.diagnostics.deleteRuns({ run: runtime.diagnostics.run });
  await runtime.diagnostics.record('warn', 'web', 'web.failed', { path: '/api/health', status: 500 });
  await runtime.diagnostics.flush();
  const entries = await read(runtime);
  assert.equal(entries.filter(entry => entry.msg === 'web.failed').length, 1);
  assert.equal(entries.filter(entry => entry.msg === 'diagnostics.repeated').length, 0);
});

test('種類の上限を超えると最も古い繰り返し件数を書き出す', async t => {
  const { runtime } = await startTestServer(t, { diagnosticsOptions: {
    repeatWindowMs: 60_000, maxRepeatKeys: 2,
  } });
  const records = [
    ['warn', 'web', 'web.failed', { path: '/api/health', status: 500 }, 2],
    ['error', 'server', 'request.failed', { method: 'GET', path: '/api/health', status: 500 }, 2],
    ['info', 'gh', 'gh.failed', { operation: 'pr view', failure: 'timeout' }, 1],
  ];
  for (const [level, tag, msg, data, count] of records) {
    for (let index = 0; index < count; index += 1) {
      await runtime.diagnostics.record(level, tag, msg, data);
    }
  }
  await runtime.diagnostics.flush();
  const repeated = (await read(runtime)).filter(entry => entry.msg === 'diagnostics.repeated');
  assert.deepEqual(repeated.map(({ level, tag, data }) => [level, tag, repeatedData(data)]), [
    ['warn', 'web', { msg: 'web.failed', count: 1, data: { path: '/api/health', status: 500 } }],
    ['error', 'server', { msg: 'request.failed', count: 1, data: { method: 'GET', path: '/api/health', status: 500 } }],
  ]);
});

test('起動と停止の mark は版とポートを残し、秘密値を含めない', async t => {
  const { runtime } = await startTestServer(t);
  const entries = await read(runtime);
  assert.equal(entries[0].level, 'mark');
  assert.equal(entries[0].msg, 'server.start');
  assert.equal(entries[0].data.port, runtime.info.port);
  assert.equal(entries[0].data.version, require('../package.json').version);
  const text = JSON.stringify(entries);
  for (const secret of [runtime.info.secret, runtime.info.uiSecret]) assert.ok(!text.includes(secret));
  await runtime.close();
  const files = await fs.readdir(path.join(runtime.homeDir, 'diagnostics'));
  const saved = await fs.readFile(path.join(runtime.homeDir, 'diagnostics', files[0]), 'utf8');
  assert.match(saved, /"msg":"server.stop"/);
});

test('失敗した要求は ID を伏せ、ヘッダーと本文とクエリーを残さない', async t => {
  const { runtime } = await startTestServer(t);
  await request(runtime.info.port, { method: 'POST', path: '/api/sessions/private-session/plan?token=query-private',
    headers: { 'x-cockpit-secret': 'header-private', origin: 'https://private.example' }, body: 'body-private' });
  const entry = (await read(runtime)).find(entry => entry.msg === 'request.failed');
  assert.deepEqual(entry.data, { method: 'POST', path: '/api/sessions/:id/plan', status: 401, secret: 'mismatch', origin: 'mismatch' });
  assert.doesNotMatch(JSON.stringify(entry), /private|header|body|token/);
});

test('silent は mark と error を残さず、error レベルは mark と error を残す', async t => {
  const { runtime } = await startTestServer(t);
  await uiPost(runtime.info, '/api/display', { diagnosticsLevel: 'silent' });
  await uiPost(runtime.info, '/api/diagnostics/delete', { all: true });
  await request(runtime.info.port, { path: '/unknown' });
  await runtime.diagnostics.record('mark', 'server', 'server.stop', { pid: process.pid });
  assert.deepEqual(await read(runtime), []);
  await uiPost(runtime.info, '/api/display', { diagnosticsLevel: 'error' });
  await runtime.diagnostics.record('mark', 'server', 'server.stop', { pid: process.pid });
  await runtime.diagnostics.record('info', 'server', 'server.stop', { pid: process.pid });
  await request(runtime.info.port, { path: '/unknown' });
  assert.deepEqual((await read(runtime)).map(entry => entry.level), ['mark', 'error']);
});

test('保存済みの silent で再起動すると起動と停止も記録しない', async t => {
  const { runtime, claudeHome } = await startTestServer(t);
  await uiPost(runtime.info, '/api/display', { diagnosticsLevel: 'silent' });
  await runtime.close();
  const next = await startServer({ homeDir: runtime.homeDir, claudeHome, port: 0 });
  t.after(() => next.close());
  assert.deepEqual(await read(next), []);
  await next.close();
  assert.equal((await next.diagnostics.listRuns()).find(run => run.current).count, 0);
});

test('要求の例外は 500 と error.code を残し、エラー文のパスを残さない', async t => {
  const { runtime } = await startTestServer(t, { webPath: path.join(__dirname, 'missing-private-page.html') });
  assert.equal((await request(runtime.info.port)).status, 500);
  const entry = (await read(runtime)).at(-1);
  assert.equal(entry.data.error.code, 'ENOENT');
  assert.equal(entry.data.status, 500);
  assert.equal(entry.data.path, '/');
  assert.doesNotMatch(JSON.stringify(entry), /missing-private-page|message|stack|Desktop/);
});

test('保存する値は許可した鍵だけになり、Error の本文とスタックとユーザー名を落とす', async t => {
  const { runtime } = await startTestServer(t);
  const error = Object.assign(new Error('command secret stderr'), { code: 'FAIL', name: 'C:\\Users\\alice\\' + 'x'.repeat(300) });
  await runtime.diagnostics.record('error', 'server', 'request.failed', { error, body: 'secret', secretToken: 'secret',
    secret: runtime.info.secret, origin: 'https://private.example', method: 'POST', path: '/api/state', status: 500 });
  const entry = (await read(runtime)).at(-1);
  assert.deepEqual(Object.keys(entry.data).sort(), ['error', 'method', 'path', 'status']);
  assert.equal(entry.data.error.code, 'FAIL');
  assert.equal(entry.data.error.name.length, 200);
  assert.match(entry.data.error.name, /<redacted>/);
  assert.doesNotMatch(JSON.stringify(entry), /alice|command|stderr|stack|message|secret/);
});

test('2000 行を超えた記録は次の区分へ順序を保って追記する', async t => {
  const { runtime } = await startTestServer(t);
  const diagnostics = runtime.diagnostics;
  await Promise.all(Array.from({ length: 2001 }, (_, pid) => diagnostics.record('mark', 'server', 'server.stop', { pid })));
  const files = (await fs.readdir(diagnostics.directory)).sort();
  assert.equal(files.length, 2);
  assert.equal((await fs.readFile(path.join(diagnostics.directory, files[0]), 'utf8')).trim().split('\n').length, 2000);
  const entries = await read(runtime);
  assert.deepEqual(entries.filter(entry => entry.msg === 'server.stop').map(entry => entry.data.pid), Array.from({ length: 2001 }, (_, i) => i));
  assert.ok(entries.some(entry => entry.msg === 'diagnostics.rotate'));
});

test('区分の上限を超えると古い区分を消して削除の mark を残す', async t => {
  const { runtime } = await startTestServer(t, { diagnosticsOptions: { maxLines: 5, maxSegments: 2 } });
  await Promise.all(Array.from({ length: 20 }, (_, pid) => runtime.diagnostics.record('mark', 'server', 'server.stop', { pid })));
  const files = await fs.readdir(runtime.diagnostics.directory);
  assert.equal(files.length, 2);
  assert.ok(!files.includes(`${runtime.diagnostics.run}.1.jsonl`));
  const entries = await read(runtime);
  assert.ok(entries.some(entry => entry.msg === 'diagnostics.pruned'));
  assert.equal(entries.at(-1).data.pid, 19);
});

test('起動の上限を超えると古い起動を消し、読み出しは開始時刻と件数を返す', async t => {
  const { runtime } = await startTestServer(t, { diagnosticsOptions: { maxRuns: 2, maxLines: 3 } });
  for (const stamp of ['20200101T000000Z', '20200102T000000Z']) {
    await fs.writeFile(path.join(runtime.diagnostics.directory, `${stamp}-1.1.jsonl`), JSON.stringify({ ts: 1,
      level: 'mark', tag: 'server', msg: 'server.start', data: { pid: 1 } }) + '\n');
  }
  await runtime.diagnostics.record('mark', 'server', 'server.stop', { pid: 2 });
  await runtime.diagnostics.record('mark', 'server', 'server.stop', { pid: 2 });
  await runtime.diagnostics.record('mark', 'server', 'server.stop', { pid: 2 });
  const data = jsonBody(await request(runtime.info.port, { path: '/api/diagnostics' }));
  assert.equal(data.runs[0].current, true);
  assert.ok(data.runs[0].count > 0);
  assert.ok(Number.isFinite(Date.parse(data.runs[0].startedAt)));
  assert.deepEqual(data.runs.map(run => run.id), [runtime.diagnostics.run, '20200102T000000Z-1']);
});

test('一覧は件数と出どころを返し、変更のないファイルを再利用して削除後は読み直す', async t => {
  const { runtime } = await startTestServer(t);
  const runId = '20200103T000000Z-1';
  const filePath = path.join(runtime.diagnostics.directory, `${runId}.1.jsonl`);
  const firstText = JSON.stringify({ ts: 1, level: 'mark', tag: 'server', msg: 'server.start', data: { pid: 1 } }) + '\n';
  await fs.writeFile(filePath, firstText);
  const originalStat = await fs.stat(filePath);
  const reads = [];
  const readFile = runtime.diagnostics.readFile.bind(runtime.diagnostics);
  runtime.diagnostics.readFile = async name => { reads.push(name); return readFile(name); };
  const runReadCount = () => reads.filter(name => name === path.basename(filePath)).length;
  const list = async () => jsonBody(await request(runtime.info.port, { path: '/api/diagnostics' }));
  const initial = (await list()).runs.find(run => run.id === runId);
  assert.equal(initial.count, 1);
  assert.deepEqual(initial.sources, ['server']);
  await list();
  assert.equal(runReadCount(), 1);

  await fs.appendFile(filePath, JSON.stringify({ ts: 2, level: 'mark', tag: 'hook', msg: 'server.stop', data: { pid: 2 } }) + '\n');
  const appended = (await list()).runs.find(run => run.id === runId);
  assert.equal(appended.count, 2);
  assert.deepEqual(appended.sources.sort(), ['hook', 'server']);
  assert.equal(runReadCount(), 2);

  await fs.unlink(filePath);
  assert.equal((await list()).runs.some(run => run.id === runId), false);
  const replacement = firstText.replace('"tag":"server"', '"tag":"web"');
  await fs.writeFile(filePath, replacement);
  await fs.utimes(filePath, originalStat.atime, originalStat.mtime);
  const recreated = (await list()).runs.find(run => run.id === runId);
  assert.equal(recreated.count, 1);
  assert.deepEqual(recreated.sources, ['web']);
  assert.equal(runReadCount(), 3);
});

test('削除は ui の秘密値と同一 Origin を求め、経路を指定しても診断ログの外に触れない', async t => {
  const { runtime } = await startTestServer(t);
  const outside = path.join(runtime.homeDir, 'keep.jsonl');
  await fs.writeFile(outside, 'keep');
  for (const [headers, status] of [[{}, 401], [{ 'x-cockpit-secret': runtime.info.secret }, 401],
    [uiHeaders(runtime.info), 403], [uiHeaders(runtime.info, 'http://elsewhere'), 403]]) {
    assert.equal((await uiPost(runtime.info, '/api/diagnostics/delete', { all: true }, headers)).status, status);
  }
  assert.equal((await uiPost(runtime.info, '/api/diagnostics/delete', { run: '../keep' })).status, 400);
  assert.equal((await request(runtime.info.port, { path: '/api/diagnostics?run=../keep' })).status, 400);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
});

test('現在の起動を削除すると次の記録は新しい区分で続ける', async t => {
  const { runtime } = await startTestServer(t);
  assert.equal((await uiPost(runtime.info, '/api/diagnostics/delete', { run: runtime.diagnostics.run })).status, 200);
  assert.deepEqual(await read(runtime), []);
  await request(runtime.info.port, { path: '/unknown' });
  const entries = await read(runtime);
  assert.equal(entries[0].msg, 'request.failed');
  assert.deepEqual(await fs.readdir(runtime.diagnostics.directory), [`${runtime.diagnostics.run}.2.jsonl`]);
});

test('診断ログを書けないときも常駐サーバーは要求へ応答する', async t => {
  const { runtime } = await startTestServer(t);
  await fs.rm(runtime.diagnostics.directory, { recursive: true });
  await fs.writeFile(runtime.diagnostics.directory, 'blocked');
  assert.equal((await request(runtime.info.port, { path: '/unknown' })).status, 404);
  await runtime.diagnostics.flush();
  assert.equal((await request(runtime.info.port, { path: '/health' })).status, 200);
});

test('二重起動が EADDRINUSE で失敗しても server.log を消さない', async t => {
  const { runtime, claudeHome } = await startTestServer(t);
  const logPath = path.join(runtime.homeDir, 'server.log');
  await fs.writeFile(logPath, 'running server log\n');
  await assert.rejects(startServer({ homeDir: runtime.homeDir, claudeHome, port: runtime.info.port }), { code: 'EADDRINUSE' });
  assert.equal(await fs.readFile(logPath, 'utf8'), 'running server log\n');
});

test('起動時に上限を超えた server.log を server.log.1 に移す', async t => {
  const { runtime, claudeHome } = await startTestServer(t);
  await runtime.close();
  const logPath = path.join(runtime.homeDir, 'server.log');
  await fs.writeFile(logPath, 'large log');
  const next = await startServer({ homeDir: runtime.homeDir, claudeHome, port: 0, maxServerLogBytes: 5 });
  t.after(() => next.close());
  assert.equal(await fs.readFile(`${logPath}.1`, 'utf8'), 'large log');
});

const eventPost = (runtime, body) => request(runtime.info.port, { method: 'POST', path: '/api/events',
  headers: { 'x-cockpit-secret': runtime.info.secret }, body: JSON.stringify(body) });

test('受け付けたイベントと遅れと開始終了は本文と入出力を残さない', async t => {
  const { runtime } = await startTestServer(t);
  await uiPost(runtime.info, '/api/display', { diagnosticsLevel: 'debug' });
  const session_id = 'diagnostic-session-private';
  for (const hook_event_name of ['SessionStart', 'PreToolUse', 'SessionEnd']) {
    await eventPost(runtime, { session_id, hook_event_name, hookAt: Date.now() - 6000,
      cwd: 'D:/private-directory/Product', tool_name: 'Bash', tool_input: { command: 'private-command' },
      tool_response: 'private-output', prompt: 'private-prompt', token: 'private-token' });
  }
  const entries = (await read(runtime)).filter(entry => entry.msg.startsWith('event.') || entry.msg === 'session.ended');
  assert.equal(entries.filter(entry => entry.msg === 'event.accepted').length, 3);
  assert.equal(entries.filter(entry => entry.msg === 'event.delayed').length, 3);
  assert.equal(entries.filter(entry => entry.msg === 'event.lifecycle').length, 2);
  assert.equal(entries.find(entry => entry.msg === 'session.ended').data.reason, 'SessionEnd');
  assert.equal(entries.find(entry => entry.msg === 'event.accepted').data.session, 'diagnost');
  assert.doesNotMatch(JSON.stringify(entries), /private|tool_input|tool_response|prompt|token/);
});

test('不正なイベントと終了済みセッションへのイベントは不採用を info で残す', async t => {
  const { runtime } = await startTestServer(t);
  await eventPost(runtime, { session_id: 'reject-session', hook_event_name: 'private-invalid-event', prompt: 'private-prompt' });
  await eventPost(runtime, { session_id: 'reject-session', hook_event_name: 'SessionEnd' });
  await eventPost(runtime, { session_id: 'reject-session', hook_event_name: 'Stop' });
  const entries = (await read(runtime)).filter(entry => entry.msg === 'event.rejected');
  assert.deepEqual(entries.map(entry => entry.data.reason), ['invalid', 'ended']);
  assert.ok(entries.every(entry => entry.level === 'info'));
  assert.doesNotMatch(JSON.stringify(entries), /private/);
});

test('受付件数はイベント名ごとに集計し、close 後は集計しない', async t => {
  const { runtime } = await startTestServer(t, { eventSummaryIntervalMs: 30 });
  await eventPost(runtime, { session_id: 'summary-session', hook_event_name: 'SessionStart' });
  await eventPost(runtime, { session_id: 'summary-session', hook_event_name: 'Stop' });
  await new Promise(resolve => setTimeout(resolve, 70));
  const entries = (await read(runtime)).filter(entry => entry.msg === 'event.summary');
  assert.equal(entries.reduce((sum, entry) => sum + (entry.data.SessionStart || 0), 0), 1);
  assert.equal(entries.reduce((sum, entry) => sum + (entry.data.Stop || 0), 0), 1);
  await runtime.close();
  const before = await runtime.diagnostics.readRun(runtime.diagnostics.run);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.deepEqual(await runtime.diagnostics.readRun(runtime.diagnostics.run), before);
});

test('常駐サーバーの処理時間は間隔ごとに件数を残し、close 後は残さない', async t => {
  const { runtime } = await startTestServer(t, { perfSummaryIntervalMs: 30 });
  await eventPost(runtime, { session_id: 'perf-session', hook_event_name: 'SessionStart' });
  await request(runtime.info.port, { path: '/api/state' });
  await new Promise(resolve => setTimeout(resolve, 70));
  const entries = (await read(runtime)).filter(entry => entry.msg === 'server.perf');
  const total = key => entries.reduce((sum, entry) => sum + (entry.data[key] || 0), 0);
  assert.ok(total('stateCount') >= 1);
  assert.ok(total('eventCount') >= 1);
  await runtime.close();
  const before = await runtime.diagnostics.readRun(runtime.diagnostics.run);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.deepEqual(await runtime.diagnostics.readRun(runtime.diagnostics.run), before);
});

test('Codex のプロセス終了とロック消失は分類だけを残し、ロック消失は走査を重ねても 1 回だけ残す', async t => {
  let alive = true;
  const codexHome = require('./support/temp').temporaryDirectory(t, 'diagnostic-codex-').directory;
  const { runtime } = await startTestServer(t, { codexHome, isAlive: () => alive });
  for (const session_id of ['codex-lock-private', 'codex-dead-private']) {
    await eventPost(runtime, { session_id, provider: 'codex', hook_event_name: 'SessionStart',
      codexPid: 12345, cwd: 'D:/private-directory/Product' });
  }
  const locks = path.join(codexHome, 'thread-writer-locks');
  await fs.mkdir(locks);
  for (const id of ['codex-lock-private', 'codex-dead-private']) await fs.writeFile(path.join(locks, `${id}.lock`), 'private-lock-content');
  await runtime.refreshSessionFiles();
  await fs.unlink(path.join(locks, 'codex-lock-private.lock'));
  await runtime.refreshSessionFiles();
  await runtime.refreshSessionFiles();
  alive = false;
  await runtime.refreshSessionFiles();
  const entries = (await read(runtime)).filter(entry => entry.msg === 'session.ended');
  assert.equal(entries.filter(entry => entry.data.reason === 'lock-missing').length, 1);
  assert.ok(entries.some(entry => entry.data.reason === 'process-dead'));
  assert.doesNotMatch(JSON.stringify(entries), /private|12345/);
});
