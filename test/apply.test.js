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
  const options = { root, userHome, cwd: root, environment: {}, readSourceState: async () => 'release',
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

test('一時ファイル作成後に MCP の登録以外だけが変わっても上書きせず skipped にする', async t => {
  const f = await fixture(t);
  await save(f);
  const value = JSON.parse(await fs.readFile(f.mcp, 'utf8'));
  const changed = JSON.stringify({ ...value, projects: { current: { count: 42 } } });
  const io = { ...fs, writeFile: async (file, ...args) => {
    await fs.writeFile(file, ...args);
    if (file.endsWith('.tmp')) await fs.writeFile(f.mcp, changed);
  } };
  const { code, report } = await run(f, [MCP_ID], { fs: io });
  assert.equal(code, 1);
  assert.equal(report.results[0].status, 'skipped');
  assert.equal(await fs.readFile(f.mcp, 'utf8'), changed);
});

test('正しいフックの後ろにある古い重複を取り除くと正しいフックが残る', async t => {
  const f = await fixture(t);
  await changeHook(f, group => { group.hooks.push({ ...structuredClone(group.hooks[0]), timeout: 1 }); });
  const before = await save(f);
  const extra = before.items.find(item => item.id.startsWith('claude.hooks.extra.SessionStart.event'));
  assert.equal(before.items.find(item => item.id === HOOK_ID).result, 'ok');
  assert.equal((await run(f, [extra.id])).code, 0);
  const after = JSON.parse(await fs.readFile(f.settings, 'utf8'));
  assert.deepEqual(after.hooks.SessionStart[0].hooks, f.manifest.claude.hooks.SessionStart[0].hooks);
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
  await write(path.join(f.userHome, '.codex/hooks.json'), { hooks: f.manifest.codex.hooks });
  const [source, destination] = Object.entries(f.manifest.codex.skills)[0];
  const content = 'スキルの正本\r\n';
  await write(path.join(f.root, source), content);
  const before = await save(f);
  const item = before.items.find(item => item.category === 'skills' && item.provider === 'codex' && item.result === 'mismatch');
  const { code, report } = await run(f, [item.id]);
  assert.equal(code, 0);
  assert.equal(await fs.readFile(path.join(f.userHome, '.agents', destination), 'utf8'), content);
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

async function reviewCopy(f, state = 'stale') {
  const root = path.join(f.directory, 'ai-cross-review');
  const source = path.join(root, '.claude/skills/cross-review/SKILL.md');
  const target = path.join(f.userHome, '.agents/skills/cross-review/SKILL.md');
  const bytes = Buffer.from('正本\r\n');
  await write(path.join(root, '.git/config'), '[remote "origin"]\nurl = https://github.com/ktysne/ai-cross-review.git\n');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, bytes);
  if (state === 'stale') await write(target, '古い写し');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const targetEntry = { id: 'agents', path: target, state, sourcePath: source,
    sourceSha256: hash(bytes), sha256: state === 'stale' ? hash('古い写し') : null };
  f.options.queryCrossReview = async () => ({ stdout: JSON.stringify({ schemaVersion: 2, targets: [targetEntry] }) });
  return { source, target, bytes, targetEntry, id: 'cross-review.skills.agents' };
}

test('copy-file は正本のバイト列を写し元の写しを退避する', async t => {
  const f = await fixture(t);
  const copy = await reviewCopy(f);
  await save(f);
  const { code, report } = await run(f, [copy.id]);
  assert.equal(code, 0);
  assert.deepEqual(await fs.readFile(copy.target), copy.bytes);
  const manifest = JSON.parse(await fs.readFile(path.join(report.backupDir, 'manifest.json'), 'utf8'));
  assert.equal(await fs.readFile(manifest[0].backup, 'utf8'), '古い写し');
  assert.ok(report.manual.some(text => text.includes('セッション')));
});

test('copy-file は UTF-8 でない写しも生のバイト列の sha256 で照合して置き直す', async t => {
  const f = await fixture(t);
  const copy = await reviewCopy(f);
  const utf16 = Buffer.from('﻿古い写し', 'utf16le');
  await fs.writeFile(copy.target, utf16);
  copy.targetEntry.sha256 = createHash('sha256').update(utf16).digest('hex');
  await save(f);
  const { code } = await run(f, [copy.id]);
  assert.equal(code, 0);
  assert.deepEqual(await fs.readFile(copy.target), copy.bytes);
});

test('copy-file の正本が照会後に変われば診断し直すよう案内して見送る', async t => {
  const f = await fixture(t);
  const copy = await reviewCopy(f);
  await save(f);
  await write(copy.source, '別の正本');
  const { code, report } = await run(f, [copy.id]);
  assert.equal(code, 1);
  assert.equal(report.results[0].status, 'skipped');
  assert.match(report.results[0].reason, /診断し直/);
  assert.equal(await fs.readFile(copy.target, 'utf8'), '古い写し');
});

test('copy-file の写しが照会後に変われば上書きしない', async t => {
  const f = await fixture(t);
  const copy = await reviewCopy(f);
  await save(f);
  await write(copy.target, '利用者の変更');
  const { report } = await run(f, [copy.id]);
  assert.equal(report.results[0].status, 'skipped');
  assert.equal(await fs.readFile(copy.target, 'utf8'), '利用者の変更');
});

test('未配置の配布先はその項目を明示して選んだときだけ置く', async t => {
  const f = await fixture(t);
  const copy = await reviewCopy(f, 'missing');
  await save(f);
  assert.equal((await run(f, [MCP_ID])).code, 0);
  await assert.rejects(fs.stat(copy.target), { code: 'ENOENT' });
  const { code, report } = await run(f, [copy.id]);
  assert.equal(code, 0);
  assert.equal(report.results[0].status, 'applied');
  assert.deepEqual(await fs.readFile(copy.target), copy.bytes);
  assert.equal(report.backupDir, null);
});

test('配布条件を満たさない項目を選んでも配布先を作らない', async t => {
  const f = await fixture(t);
  const copy = await reviewCopy(f, 'skipped');
  await save(f);
  const { code, report } = await run(f, [copy.id]);
  assert.equal(code, 1);
  assert.equal(report.results[0].status, 'skipped');
  await assert.rejects(fs.stat(path.dirname(copy.target)), { code: 'ENOENT' });
});

test('未配置だった写しが一致済みなら already-ok にする', async t => {
  const f = await fixture(t);
  const copy = await reviewCopy(f, 'missing');
  await save(f);
  copy.targetEntry.state = 'match';
  copy.targetEntry.sha256 = copy.targetEntry.sourceSha256;
  const { code, report } = await run(f, [copy.id]);
  assert.equal(code, 0);
  assert.equal(report.results[0].status, 'already-ok');
});

test('copy-file でも rename 直前に変わった写しを上書きしない', async t => {
  const f = await fixture(t);
  const copy = await reviewCopy(f);
  await save(f);
  const io = { ...fs, writeFile: async (file, ...args) => {
    await fs.writeFile(file, ...args);
    if (file.endsWith('.tmp')) await write(copy.target, '同時更新');
  } };
  const { report } = await run(f, [copy.id], { fs: io });
  assert.equal(report.results[0].status, 'skipped');
  assert.equal(await fs.readFile(copy.target, 'utf8'), '同時更新');
});

test('未配置だった写しが再診断で対象外なら配布しない', async t => {
  const f = await fixture(t);
  const copy = await reviewCopy(f, 'missing');
  await save(f);
  copy.targetEntry.state = 'skipped';
  const { report } = await run(f, [copy.id]);
  assert.equal(report.results[0].status, 'skipped');
  await assert.rejects(fs.stat(copy.target), { code: 'ENOENT' });
});

test('再診断で正本の digest が変われば保存した対処を適用しない', async t => {
  const f = await fixture(t);
  const copy = await reviewCopy(f);
  await save(f);
  copy.targetEntry.sourceSha256 = 'c'.repeat(64);
  const { report } = await run(f, [copy.id]);
  assert.equal(report.results[0].status, 'skipped');
  assert.equal(await fs.readFile(copy.target, 'utf8'), '古い写し');
});

async function bridgeCopies(f) {
  const root = path.join(f.directory, 'claude-codex-bridge');
  await write(path.join(root, '.git/config'), '[remote "origin"]\nurl = https://github.com/ktysne/claude-codex-bridge.git\n');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const items = [];
  for (const [kind, name, requires] of [
    ['script', 'b.sh', []], ['script', 'a.sh', []], ['gpt-agent', 'agent.md', ['script:b.sh']],
    ['claude-agent', 'agent.md', ['gpt-agent:agent.md']],
  ]) {
    const source = path.join(root, kind, name);
    const target = path.join(f.userHome, kind, name);
    await write(source, '正本\r\n');
    await write(target, '古い写し');
    items.push({ id: `${kind}:${name}`, kind, name, source, target, requires, status: 'stale', reason: 'content-differs',
      source_sha256: hash('正本\r\n'), observed_sha256: hash('古い写し'), content: '配置内容\n' });
  }
  const query = { protocol: 1, items, order: ['script', 'gpt-agent', 'claude-agent'], after: [{ id: 'review-role-section', when: 'any' }] };
  f.options.queryBridge = async () => ({ stdout: JSON.stringify(query) });
  return { items, query, ids: items.map(item => `bridge.copies.${item.kind}.${item.name}`), hash };
}

test('write は照会の内容を UTF-8 で加工せず書いて元のバイト列を退避する', async t => {
  const f = await fixture(t);
  const copy = await bridgeCopies(f);
  const item = copy.items[0];
  const bytes = Buffer.from('古い写し', 'utf16le');
  await fs.writeFile(item.target, bytes);
  item.observed_sha256 = copy.hash(bytes);
  await save(f);
  const { code, report } = await run(f, [copy.ids[0]]);
  assert.equal(code, 0);
  assert.deepEqual(await fs.readFile(item.target), Buffer.from(item.content, 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(report.backupDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(await fs.readFile(manifest[0].backup), bytes);
  assert.ok(report.manual.some(text => text.includes('役割分担')));
});

test('必須の写しが無い項目は新しく置く', async t => {
  const f = await fixture(t);
  const copy = await bridgeCopies(f);
  Object.assign(copy.items[0], { status: 'missing', reason: 'required', observed_sha256: null });
  await fs.rm(copy.items[0].target);
  await save(f);
  const { code, report } = await run(f, [copy.ids[0]]);
  assert.equal(code, 0);
  assert.equal(report.backupDir, null);
  assert.equal(await fs.readFile(copy.items[0].target, 'utf8'), copy.items[0].content);
});

test('write の正本か写しが照会後に変われば上書きせず見送る', async t => {
  for (const field of ['source', 'target']) {
    const f = await fixture(t);
    const copy = await bridgeCopies(f);
    await save(f);
    await write(copy.items[0][field], '利用者の変更');
    const { code, report } = await run(f, [copy.ids[0]]);
    assert.equal(code, 1);
    assert.equal(report.results[0].status, 'skipped');
    assert.match(report.results[0].reason, /診断し直/);
    assert.equal(await fs.readFile(copy.items[0].target, 'utf8'), field === 'target' ? '利用者の変更' : '古い写し');
  }
});

test('write の一時ファイルを書いた後に正本か写しが変わっても見送る', async t => {
  for (const field of ['source', 'target']) {
    const f = await fixture(t);
    const copy = await bridgeCopies(f);
    await save(f);
    const io = { ...fs, writeFile: async (file, ...args) => {
      await fs.writeFile(file, ...args);
      if (file.endsWith('.tmp')) await write(copy.items[0][field], '同時更新');
    } };
    const { report } = await run(f, [copy.ids[0]], { fs: io });
    assert.equal(report.results[0].status, 'skipped');
    assert.equal(await fs.readFile(copy.items[0].target, 'utf8'), field === 'target' ? '同時更新' : '古い写し');
  }
});

test('bridge の依存の閉包に選び漏れがあれば足りない id を案内する', async t => {
  const f = await fixture(t);
  const copy = await bridgeCopies(f);
  await save(f);
  const { report } = await run(f, [copy.ids[3]]);
  assert.equal(report.results[0].status, 'skipped');
  assert.ok(report.results[0].reason.includes(copy.ids[0]));
  assert.ok(report.results[0].reason.includes(copy.ids[2]));
  assert.equal(await fs.readFile(copy.items[3].target, 'utf8'), '古い写し');
});

test('bridge の依存に未確認か未配置があれば明示して選んでも見送る', async t => {
  for (const status of ['unreadable', 'not-deployed']) {
    const f = await fixture(t);
    const copy = await bridgeCopies(f);
    copy.items[0].status = status;
    await save(f);
    const { report } = await run(f, [copy.ids[3], copy.ids[2], copy.ids[0]]);
    assert.ok(report.results.every(result => result.status === 'skipped'));
    assert.ok(report.results.find(result => result.id === copy.ids[3]).reason.includes(copy.ids[0]));
  }
});

test('bridge は order と同じ kind の id の順に置く', async t => {
  const f = await fixture(t);
  const copy = await bridgeCopies(f);
  const renamed = [];
  await save(f);
  const io = { ...fs, rename: async (from, to) => { renamed.push(to); await fs.rename(from, to); } };
  const { code, report } = await run(f, [...copy.ids].reverse(), { fs: io });
  assert.equal(code, 0);
  assert.ok(report.results.every(result => result.status === 'applied'));
  assert.deepEqual(renamed, [1, 0, 2, 3].map(index => copy.items[index].target));
});

test('bridge の前提の適用が失敗したら後の項目を見送る', async t => {
  const f = await fixture(t);
  const copy = await bridgeCopies(f);
  await save(f);
  const io = { ...fs, rename: async (from, to) => {
    if (to === copy.items[0].target) throw Object.assign(new Error(), { code: 'EACCES' });
    await fs.rename(from, to);
  } };
  const { report } = await run(f, [copy.ids[3], copy.ids[2], copy.ids[0]], { fs: io });
  assert.equal(report.results.find(result => result.id === copy.ids[0]).status, 'failed');
  for (const id of [copy.ids[2], copy.ids[3]]) {
    const result = report.results.find(result => result.id === id);
    assert.equal(result.status, 'skipped');
    assert.ok(result.reason.includes(copy.ids[0]));
  }
});

test('bridge の前提が既に一致していれば選択されていなくても適用できる', async t => {
  const f = await fixture(t);
  const copy = await bridgeCopies(f);
  copy.items[0].status = 'match';
  await save(f);
  const { code } = await run(f, [copy.ids[2]]);
  assert.equal(code, 0);
  assert.equal(await fs.readFile(copy.items[2].target, 'utf8'), copy.items[2].content);
});

test('bridge の前提が再診断で一致済みなら already-ok として後を適用できる', async t => {
  const f = await fixture(t);
  const copy = await bridgeCopies(f);
  await save(f);
  copy.items[0].status = 'match';
  const { code, report } = await run(f, [copy.ids[2], copy.ids[0]]);
  assert.equal(code, 0);
  assert.equal(report.results.find(result => result.id === copy.ids[0]).status, 'already-ok');
  assert.equal(report.results.find(result => result.id === copy.ids[2]).status, 'applied');
});

test('bridge の前提が変化で見送られたら後の項目も見送る', async t => {
  const f = await fixture(t);
  const copy = await bridgeCopies(f);
  await save(f);
  await write(copy.items[0].source, '正本の変更');
  const { report } = await run(f, [copy.ids[3], copy.ids[2], copy.ids[0]]);
  assert.ok(report.results.every(result => result.status === 'skipped'));
  assert.ok(report.results.find(result => result.id === copy.ids[3]).reason.includes(copy.ids[0]));
  assert.equal(await fs.readFile(copy.items[3].target, 'utf8'), '古い写し');
});

test('bridge の順を並べ替えてもほかのツールの項目の順を保つ', async t => {
  const f = await fixture(t);
  const copy = await bridgeCopies(f);
  const review = await reviewCopy(f);
  await save(f);
  const renamed = [];
  const io = { ...fs, rename: async (from, to) => { renamed.push(to); await fs.rename(from, to); } };
  const { code } = await run(f, [copy.ids[3], MCP_ID, copy.ids[2], review.id, copy.ids[0]], { fs: io });
  assert.equal(code, 0);
  assert.deepEqual(renamed, [copy.items[0].target, f.mcp, copy.items[2].target, review.target, copy.items[3].target]);
});

test('古い離席用 matcher を doctor が検出し apply が wrap_up を含む登録に直す', async t => {
  const f = await fixture(t);
  await changeHook(f, (group, settings) => { settings.hooks.PreToolUse[1].matcher = 'AskUserQuestion'; });
  const report = await save(f);
  const items = report.items.filter(item => item.id.startsWith('claude.hooks.') && item.id.includes('PreToolUse') && item.id.includes('away'));
  assert.ok(items.length);
  assert.ok(items.every(item => item.result === 'mismatch'));
  assert.equal((await run(f, items.map(item => item.id))).code, 0);
  const hooks = JSON.parse(await fs.readFile(f.settings, 'utf8')).hooks.PreToolUse;
  assert.deepEqual(hooks, f.manifest.claude.hooks.PreToolUse);
});
