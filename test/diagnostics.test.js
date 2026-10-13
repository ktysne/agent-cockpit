const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startServer } = require('../src/server/server');
const { request, jsonBody, startTestServer, uiHeaders } = require('./support/server');

const uiPost = (info, route, body, headers = uiHeaders(info, `http://127.0.0.1:${info.port}`)) => request(info.port,
  { method: 'POST', path: route, headers, body: JSON.stringify(body) });
const read = async (runtime, run = runtime.diagnostics.run) => jsonBody(await request(runtime.info.port,
  { path: `/api/diagnostics?run=${encodeURIComponent(run)}` })).entries;

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
