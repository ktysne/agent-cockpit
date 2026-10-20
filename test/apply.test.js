const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { main } = require('../src/client/apply');
const { diagnose } = require('../src/client/doctor');
const { integrationManifest } = require('../src/shared/integration-manifest');

const ROOT = path.resolve(__dirname, '..');
const COMMIT = 'a'.repeat(40);
const MCP_ID = 'claude.mcp.registration';
const HOOK_ID = 'claude.hooks.SessionStart.all.event';

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(ROOT, 'apply-fixture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'agent-cockpit');
  const userHome = path.join(directory, 'home');
  const claude = path.join(userHome, '.claude');
  const codex = path.join(userHome, '.codex');
  const home = path.join(userHome, '.agent-cockpit');
  const settings = path.join(claude, 'settings.json');
  const mcp = path.join(userHome, '.claude.json');
  const config = path.join(codex, 'config.toml');
  await write(path.join(root, 'package.json'), { name: 'agent-cockpit', version: '1.8.0' });
  await write(path.join(root, '.git', 'HEAD'), COMMIT);
  const manifest = integrationManifest(root);
  await write(settings, { hooks: manifest.claude.hooks });
  await write(mcp, { mcpServers: { 'agent-cockpit': { command: 'old', args: [], env: { TOKEN: 'private' } }, other: { command: 'custom' } } });
  await write(path.join(home, 'server.json'), { port: 47821, pid: 123, startedAt: 'start', secret: 'server-private' });
  const options = { root, userHome, environment: {}, readSourceState: async () => 'release',
    fetchImpl: async url => ({ ok: true, status: 200, json: async () => url.endsWith('/health')
      ? { app: 'agent-cockpit', pid: 123, startedAt: 'start', version: 'old', commit: COMMIT, sourceState: 'release' }
      : { runs: [] } }) };
  const source = path.join(directory, 'diagnosis.json');
  return { directory, root, userHome, home, settings, mcp, config, manifest, options, source };
}

async function save(f) {
  const report = await diagnose(f.options);
  await write(f.source, report);
  return report;
}

async function run(f, ids, options = {}) {
  let output;
  const code = await main(['--from', f.source, ...ids.flatMap(id => ['--item', id]), '--json'],
    { ...f.options, ...options, log: text => { output = text; } });
  return { code, report: JSON.parse(output), output };
}

async function changeHook(f, change) {
  const value = JSON.parse(await fs.readFile(f.settings, 'utf8'));
  change(value.hooks.SessionStart[0], value);
  await write(f.settings, value);
}

test('フックの置き換えは同じグループの利用者のフックと書式を残す', async t => {
  const f = await fixture(t);
  const custom = { type: 'command', command: 'my-tool' };
  await changeHook(f, group => { group.hooks[0].timeout = 1; group.hooks.push(custom); });
  const before = JSON.parse(await fs.readFile(f.settings, 'utf8'));
  await write(f.settings, JSON.stringify(before, null, '\t').replace(/\n/g, '\r\n') + '\r\n');
  await save(f);
  const { code, report } = await run(f, [HOOK_ID]);
  assert.equal(code, 0);
  assert.equal(report.results[0].status, 'applied');
  const after = await fs.readFile(f.settings, 'utf8');
  assert.deepEqual(JSON.parse(after).hooks.SessionStart[0].hooks, [f.manifest.claude.hooks.SessionStart[0].hooks[0], custom]);
  assert.match(after, /\r\n\t"hooks"/);
  assert.ok(after.endsWith('\r\n'));
});

test('MCP の command と args を直しても env とほかの登録を残す', async t => {
  const f = await fixture(t);
  await save(f);
  const { code, output } = await run(f, [MCP_ID]);
  assert.equal(code, 0);
  const value = JSON.parse(await fs.readFile(f.mcp, 'utf8'));
  assert.deepEqual(value.mcpServers['agent-cockpit'], { ...f.manifest.claude.mcp, env: { TOKEN: 'private' } });
  assert.deepEqual(value.mcpServers.other, { command: 'custom' });
  assert.ok(!output.includes('private'));
  assert.ok(!(await fs.readFile(f.mcp, 'utf8')).endsWith('\n'));
});

test('診断後に MCP の登録以外が変わってもその内容を残して適用する', async t => {
  const f = await fixture(t);
  await save(f);
  const value = JSON.parse(await fs.readFile(f.mcp, 'utf8'));
  value.projects = { current: { count: 42 } };
  await write(f.mcp, value);
  assert.equal((await run(f, [MCP_ID])).code, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(f.mcp, 'utf8')).projects, value.projects);
});

for (const fileKey of ['settings', 'mcp']) {
  test(`診断後に ${fileKey} の対象が変わると skipped で元の内容を残す`, async t => {
    const f = await fixture(t);
    await changeHook(f, group => { group.hooks[0].timeout = 1; });
    await save(f);
    if (fileKey === 'settings') await changeHook(f, group => { group.hooks[0].timeout = 2; });
    else {
      const value = JSON.parse(await fs.readFile(f.mcp, 'utf8'));
      value.mcpServers['agent-cockpit'].args = ['changed'];
      await write(f.mcp, value);
    }
    const before = await fs.readFile(f[fileKey], 'utf8');
    const { code, report } = await run(f, [fileKey === 'settings' ? HOOK_ID : MCP_ID]);
    assert.equal(code, 1);
    assert.equal(report.results[0].status, 'skipped');
    assert.equal(await fs.readFile(f[fileKey], 'utf8'), before);
    assert.equal(report.backupDir, null);
  });
}

test('一時ファイル作成後に対象が変わると rename せず skipped にする', async t => {
  const f = await fixture(t);
  await save(f);
  const changed = JSON.stringify({ mcpServers: { 'agent-cockpit': { command: 'newer', args: [] } } });
  const io = { ...fs, writeFile: async (file, ...args) => {
    await fs.writeFile(file, ...args);
    if (file.endsWith('.tmp')) await fs.writeFile(f.mcp, changed);
  } };
  const { code, report } = await run(f, [MCP_ID], { fs: io });
  assert.equal(code, 1);
  assert.equal(report.results[0].status, 'skipped');
  assert.equal(await fs.readFile(f.mcp, 'utf8'), changed);
  assert.ok(!(await fs.readdir(path.dirname(f.mcp))).some(file => file.endsWith('.tmp')));
});

test('同じ古いフックの置き換えと余分な登録の取り除きで期待する 1 件だけ残る', async t => {
  const f = await fixture(t);
  await changeHook(f, group => { group.hooks[0].timeout = 1; group.hooks.push(structuredClone(group.hooks[0])); });
  const before = await save(f);
  const extra = before.items.find(item => item.id.startsWith('claude.hooks.extra.SessionStart.event'));
  assert.equal((await run(f, [HOOK_ID, extra.id])).code, 0);
  const after = JSON.parse(await fs.readFile(f.settings, 'utf8'));
  assert.deepEqual(after.hooks.SessionStart[0].hooks, f.manifest.claude.hooks.SessionStart[0].hooks);
});

test('存在しないフック設定を作って選んだグループだけを登録する', async t => {
  const f = await fixture(t);
  await fs.unlink(f.settings);
  await save(f);
  assert.equal((await run(f, [HOOK_ID])).code, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(f.settings, 'utf8')), {
    hooks: { SessionStart: [f.manifest.claude.hooks.SessionStart[0]] },
  });
});

test('matcher を直すときは元のグループの利用者のフックを残す', async t => {
  const f = await fixture(t);
  const custom = { type: 'command', command: 'custom' };
  await changeHook(f, group => { group.matcher = 'Custom'; group.hooks.push(custom); });
  const report = await save(f);
  const extra = report.items.find(item => item.id.startsWith('claude.hooks.extra.SessionStart.event'));
  assert.equal((await run(f, [HOOK_ID, extra.id])).code, 0);
  const groups = JSON.parse(await fs.readFile(f.settings, 'utf8')).hooks.SessionStart;
  assert.deepEqual(groups[0], { matcher: 'Custom', hooks: [custom] });
  assert.deepEqual(groups.at(-1), f.manifest.claude.hooks.SessionStart[0]);
});

test('退避に失敗したファイルを書かず failed にする', async t => {
  const f = await fixture(t);
  await save(f);
  const before = await fs.readFile(f.mcp, 'utf8');
  const io = { ...fs, writeFile: async (file, ...args) => {
    if (file.includes(`${path.sep}backups${path.sep}`)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.writeFile(file, ...args);
  } };
  const { code, report } = await run(f, [MCP_ID], { fs: io });
  assert.equal(code, 1);
  assert.equal(report.results[0].status, 'failed');
  assert.equal(await fs.readFile(f.mcp, 'utf8'), before);
});

test('退避の時刻が同じでも前の退避と manifest を上書きしない', async t => {
  const f = await fixture(t);
  const now = () => new Date('2026-02-01T00:00:00.000Z');
  await changeHook(f, group => { group.hooks[0].timeout = 1; });
  await save(f);
  const first = await run(f, [MCP_ID], { now });
  const file = path.join(first.report.backupDir, 'manifest.json');
  const before = await fs.readFile(file, 'utf8');
  const second = await run(f, [HOOK_ID], { now });
  assert.equal(second.code, 0);
  assert.notEqual(second.report.backupDir, first.report.backupDir);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('フックから解決する checkout が診断後に変わるとすべて skipped にする', async t => {
  const f = await fixture(t);
  f.options.root = undefined;
  await save(f);
  const other = path.join(f.directory, 'other');
  await write(path.join(other, 'package.json'), { name: 'agent-cockpit', version: '1.8.0' });
  await write(f.settings, { hooks: integrationManifest(other).claude.hooks });
  const before = await fs.readFile(f.mcp, 'utf8');
  const { code, report } = await run(f, [MCP_ID]);
  assert.equal(code, 1);
  assert.equal(report.results[0].status, 'skipped');
  assert.match(report.results[0].reason, /checkout/);
  assert.equal(await fs.readFile(f.mcp, 'utf8'), before);
});

test('mcpServers が object でないと failed で内容を変えない', async t => {
  const f = await fixture(t);
  await write(f.mcp, { mcpServers: [] });
  const before = await fs.readFile(f.mcp, 'utf8');
  await save(f);
  const { code, report } = await run(f, [MCP_ID]);
  assert.equal(code, 1);
  assert.equal(report.results[0].status, 'failed');
  assert.equal(await fs.readFile(f.mcp, 'utf8'), before);
});

test('診断後に既に直った項目は already-ok で書き込まない', async t => {
  const f = await fixture(t);
  await save(f);
  await write(f.mcp, { mcpServers: { 'agent-cockpit': f.manifest.claude.mcp } });
  const { code, report } = await run(f, [MCP_ID]);
  assert.equal(code, 0);
  assert.equal(report.results[0].status, 'already-ok');
  assert.equal(report.backupDir, null);
});

test('copy は不足した親を作り正本のバイト列を写して再診断で一致する', async t => {
  const f = await fixture(t);
  const [source, destination] = Object.entries(f.manifest.claude.skills)[0];
  const content = 'スキルの正本\r\n';
  await write(path.join(f.root, source), content);
  const before = await save(f);
  const item = before.items.find(item => item.category === 'skills' && item.provider === 'claude' && item.result === 'mismatch');
  const { code, report } = await run(f, [item.id]);
  assert.equal(code, 0);
  assert.equal(await fs.readFile(path.join(f.userHome, '.claude', destination), 'utf8'), content);
  assert.equal((await diagnose(f.options)).items.find(entry => entry.id === item.id).result, 'ok');
  assert.equal(report.backupDir, null);
});

for (const shape of ['existing', 'key', 'table']) {
  test(`toml-set は ${shape} の設定を直し hooks.state とほかの表を残す`, async t => {
    const f = await fixture(t);
    const state = '[hooks.state]\r\ntrusted = ["private"]\r\n';
    const other = '[other]\r\nvalue = "keep"\r\n';
    const registration = shape === 'table' ? '' : '[mcp_servers . "agent-cockpit"] # registration\r\n# command = "comment"\r\n'
      + (shape === 'existing' ? '"command" = "old"\r\nargs = []\r\n' : 'command = "old"\r\n');
    await write(f.config, state + registration + other);
    await write(path.join(f.userHome, '.codex', 'hooks.json'), { hooks: f.manifest.codex.hooks });
    await save(f);
    assert.equal((await run(f, ['codex.mcp.registration'])).code, 0);
    const after = await fs.readFile(f.config, 'utf8');
    assert.ok(after.includes(state));
    assert.ok(after.includes(other));
    assert.ok(after.includes(`command = ${JSON.stringify(f.manifest.codex.mcp.command)}`));
    assert.ok(after.includes(`args = [${f.manifest.codex.mcp.args.map(value => JSON.stringify(value)).join(', ')}]`));
    assert.equal((await diagnose(f.options)).items.find(item => item.id === 'codex.mcp.registration').result, 'ok');
  });
}

test('退避には元の内容と manifest を残し新しい 10 回より古いものだけ消す', async t => {
  const f = await fixture(t);
  const base = path.join(f.home, 'backups');
  const stamps = Array.from({ length: 10 }, (_, index) => `2026-01-${String(index + 1).padStart(2, '0')}T00-00-00-000Z`);
  for (const stamp of stamps) await fs.mkdir(path.join(base, stamp), { recursive: true });
  await fs.mkdir(path.join(base, 'keep-this'));
  const before = await fs.readFile(f.mcp);
  await save(f);
  const { code, report } = await run(f, [MCP_ID], { now: () => new Date('2026-02-01T00:00:00.000Z') });
  assert.equal(code, 0);
  const manifest = JSON.parse(await fs.readFile(path.join(report.backupDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, [{ original: f.mcp, backup: path.join(report.backupDir, '1-.claude.json'), sha256: createHash('sha256').update(before).digest('hex') }]);
  assert.deepEqual(await fs.readFile(manifest[0].backup), before);
  assert.deepEqual((await fs.readdir(base)).sort(), [...stamps.slice(1), path.basename(report.backupDir), 'keep-this'].sort());
  if (process.platform !== 'win32') {
    for (const file of [base, report.backupDir]) assert.equal((await fs.stat(file)).mode & 0o777, 0o700);
    for (const file of [manifest[0].backup, path.join(report.backupDir, 'manifest.json')]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
});

test('入力に無い id があれば有効な項目も書き換えず終了コード 2 にする', async t => {
  const f = await fixture(t);
  await save(f);
  const before = await fs.readFile(f.mcp, 'utf8');
  assert.equal((await run(f, [MCP_ID, 'missing'])).code, 2);
  assert.equal(await fs.readFile(f.mcp, 'utf8'), before);
  await assert.rejects(fs.stat(path.join(f.home, 'backups')), { code: 'ENOENT' });
});

test('command は選んだときだけファイルを書いた後に execFile で実行する', async t => {
  const f = await fixture(t);
  const calls = [];
  const execFile = async (...args) => {
    calls.push(args);
    assert.equal(JSON.parse(await fs.readFile(f.mcp, 'utf8')).mcpServers['agent-cockpit'].command, f.manifest.claude.mcp.command);
  };
  await save(f);
  assert.equal((await run(f, [MCP_ID], { execFile })).code, 0);
  assert.deepEqual(calls, []);
  await write(f.mcp, { mcpServers: { 'agent-cockpit': { command: 'old', args: [] } } });
  await save(f);
  const { code, report } = await run(f, ['cockpit.server.running', MCP_ID], { execFile });
  assert.equal(code, 0);
  assert.deepEqual(calls, [[process.execPath, [path.join(f.root, 'src/client/restart-server.js'), '--json'], { cwd: f.root }]]);
  assert.deepEqual(report.commands, [{ command: 'node src/client/restart-server.js --json', exitCode: 0 }]);
});
