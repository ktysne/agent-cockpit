const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readSourceCommit, readSourceState } = require('../src/server/source-revision');
const { startTestServer, request, jsonBody } = require('./support/server');
const { temporaryDirectory } = require('./support/temp');
const { Diagnostics } = require('../src/server/diagnostics');

const commit = 'c933f60' + 'a'.repeat(33);
const revisionOptions = { appVersion: '1.4.0', readSourceCommit: async () => commit };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('ソースの判定を待たずに応答し、確定後は state のキャッシュを更新する', async t => {
  let finish;
  const source = new Promise(resolve => { finish = resolve; });
  t.after(() => finish('diverged'));
  const { runtime, info } = await startTestServer(t, { ...revisionOptions, readSourceState: () => source });
  const health = jsonBody(await request(info.port, { path: '/health' }));
  assert.deepEqual(health, { app: 'agent-cockpit', pid: info.pid, startedAt: info.startedAt,
    version: '1.4.0', commit, sourceState: 'pending' });
  const pending = jsonBody(await request(info.port, { path: '/api/diagnostics' }));
  assert.equal(pending.responseRuntime.sourceState, 'pending');
  assert.equal(pending.runs.find(run => run.current).runtime.sourceState, 'pending');
  const before = await request(info.port, { path: '/api/state' });
  assert.deepEqual(jsonBody(before).runtime, { version: '1.4.0', commit, sourceState: 'pending', startedAt: info.startedAt });
  finish('diverged');
  await tick();
  const after = await request(info.port, { path: '/api/state', headers: { 'if-none-match': before.headers.etag } });
  assert.equal(after.status, 200);
  assert.equal(jsonBody(after).runtime.sourceState, 'diverged');
  assert.equal(jsonBody(await request(info.port, { path: '/health' })).sourceState, 'diverged');
  const entries = await runtime.diagnostics.readRun(runtime.diagnostics.run);
  assert.deepEqual(entries.find(entry => entry.msg === 'server.start').data,
    { pid: info.pid, port: info.port, version: '1.4.0', commit });
  assert.deepEqual(entries.find(entry => entry.msg === 'server.source').data, { sourceState: 'diverged' });
});

test('close はソースの確定と記録を待ってからサーバーを閉じる', async t => {
  let finish;
  const source = new Promise(resolve => { finish = resolve; });
  t.after(() => finish('release'));
  const { runtime } = await startTestServer(t, { ...revisionOptions, readSourceState: () => source });
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false);
  finish('release');
  await closing;
  const entries = await runtime.diagnostics.readRun(runtime.diagnostics.run);
  assert.ok(entries.findIndex(entry => entry.msg === 'server.source') < entries.findIndex(entry => entry.msg === 'server.stop'));
  assert.equal(runtime.server.listening, false);
});

for (const sourceState of ['release', 'diverged', 'dirty', 'unknown']) {
  test(`一時リポジトリのソースを ${sourceState} と判定して診断に残す`, async t => {
    const { directory: root } = temporaryDirectory(t);
    const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-config') } });
    git('init');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    await fs.writeFile(path.join(root, 'tracked'), 'one');
    git('add', 'tracked');
    git('commit', '-m', 'initial');
    if (sourceState !== 'unknown') git('tag', '-a', 'v1.4.0', '-m', 'release');
    if (sourceState === 'diverged') {
      await fs.writeFile(path.join(root, 'tracked'), 'two');
      git('commit', '-am', 'next');
    }
    if (sourceState === 'dirty') await fs.writeFile(path.join(root, 'tracked'), 'dirty');
    await fs.writeFile(path.join(root, 'untracked'), 'ignored');
    const { runtime } = await startTestServer(t, { appVersion: '1.4.0', sourceRoot: root,
      readSourceCommit, readSourceState });
    await runtime.close();
    assert.equal((await runtime.diagnostics.listRuns())[0].runtime.sourceState, sourceState);
    assert.equal((await runtime.diagnostics.listRuns())[0].runtime.commit, git('rev-parse', 'HEAD').toString().trim());
  });
}

test('git を起動できない場合は unknown を返す', async t => {
  const { info } = await startTestServer(t, { ...revisionOptions,
    readSourceState: options => readSourceState({ ...options, execFileImpl: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }) });
  assert.equal(jsonBody(await request(info.port, { path: '/health' })).sourceState, 'unknown');
});

async function writeRun(directory, id, segments) {
  await fs.mkdir(directory, { recursive: true });
  for (let index = 0; index < segments.length; index++) {
    const entries = segments[index].map(([msg, data]) => ({ ts: index + 1, level: 'mark', tag: 'server', msg, data }));
    await fs.writeFile(path.join(directory, `${id}.${index + 1}.jsonl`), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  }
}

test('過去の起動は版とソースの最初の確定記録を独立に復元し、無い版を補わない', async t => {
  const { runtime, info } = await startTestServer(t, { ...revisionOptions, readSourceState: () => 'dirty' });
  const version = { version: '1.3.0', commit: '9fa2714' + 'b'.repeat(33) };
  const cases = [
    [[['server.start', version]], [['diagnostics.rotate', { ...version, sourceState: 'pending' }]],
      [['server.source', { sourceState: 'release' }], ['diagnostics.rotate', { ...version, sourceState: 'dirty' }]]],
    [[['diagnostics.rotate', { ...version, sourceState: 'diverged' }]]],
    [[['server.start', version]]],
    [[['server.stop', { pid: 1 }], ['server.source', { sourceState: 'dirty' }]]],
  ];
  for (let index = 0; index < cases.length; index++) await writeRun(runtime.diagnostics.directory, `20261010T000000Z-${index + 1}`, cases[index]);
  const expected = ['release', 'diverged', 'unknown', null];
  for (let repeat = 0; repeat < 2; repeat++) {
    const listed = jsonBody(await request(info.port, { path: '/api/diagnostics' }));
    for (let index = 0; index < cases.length; index++) {
      const id = `20261010T000000Z-${index + 1}`;
      const response = jsonBody(await request(info.port, { path: `/api/diagnostics?run=${id}` }));
      const wanted = expected[index] ? { ...version, sourceState: expected[index] } : null;
      assert.deepEqual(listed.runs.find(run => run.id === id).runtime, wanted);
      assert.deepEqual(response.runtime, wanted);
      assert.deepEqual(response.responseRuntime, { version: '1.4.0', commit, sourceState: 'dirty' });
    }
  }
});

test('起動時の区分が prune で消えても rotate から版と確定状態を復元する', async t => {
  const { directory: homeDir } = temporaryDirectory(t);
  const runtime = { version: '1.3.0', commit, sourceState: 'release' };
  const diagnostics = new Diagnostics({ homeDir, maxLines: 3, maxSegments: 1, startedAt: '2026-10-10' });
  t.after(() => diagnostics.flush());
  diagnostics.setRuntime(runtime);
  await diagnostics.record('mark', 'server', 'server.start', runtime);
  for (let index = 0; index < 5; index++) await diagnostics.record('mark', 'server', 'server.stop', { pid: index });
  const entries = await diagnostics.readRun(diagnostics.run);
  assert.equal(entries.some(entry => entry.msg === 'server.start'), false);
  const reader = new Diagnostics({ homeDir, startedAt: '2026-10-11' });
  t.after(() => reader.flush());
  assert.deepEqual((await reader.listRuns()).find(run => !run.current).runtime, runtime);
});


for (const format of ['loose', 'packed', 'worktree']) {
  test(`Git の ${format} 参照から読んだ commit を起動後も保持する`, async t => {
    const { directory: root } = temporaryDirectory(t);
    const common = path.join(root, format === 'worktree' ? 'common' : '.git');
    const gitDir = format === 'worktree' ? path.join(common, 'worktrees', 'checkout') : common;
    await fs.mkdir(path.join(common, 'refs', 'heads'), { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    if (format === 'worktree') {
      await fs.writeFile(path.join(root, '.git'), `gitdir: ${gitDir}\n`);
      await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
    }
    const reference = format === 'loose' ? path.join(common, 'refs', 'heads', 'main') : path.join(common, 'packed-refs');
    await fs.writeFile(reference, format === 'loose' ? `${commit}\n` : `${commit} refs/heads/main\n`);
    const { info } = await startTestServer(t, { appVersion: '1.4.0', sourceRoot: root, readSourceCommit });
    await fs.writeFile(reference, 'b'.repeat(40));
    assert.equal(jsonBody(await request(info.port, { path: '/health' })).commit, commit);
    assert.equal(jsonBody(await request(info.port, { path: '/api/state' })).runtime.commit, commit);
  });
}
