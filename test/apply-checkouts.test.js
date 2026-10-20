const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { main } = require('../src/client/apply');

const { temporaryDirectory } = require('./support/temp');

const execute = promisify(execFile);
// この checkout が .claude/worktrees/ の下にあると、fixture の agent-cockpit が worktree として更新を拒まれるため、OS の一時フォルダーに置く。
const GIT_HOME = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'apply-checkouts-home-'));
process.on('exit', () => require('node:fs').rmSync(GIT_HOME, { recursive: true, force: true }));
const gitEnvironment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
  HOME: GIT_HOME, USERPROFILE: GIT_HOME, GIT_CONFIG_GLOBAL: path.join(GIT_HOME, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' };

function executeIsolated(file, args, options = {}) {
  return execute(file, args, { ...options, env: gitEnvironment });
}

async function git(root, ...args) {
  return (await executeIsolated('git', ['-C', root, ...args], { windowsHide: true })).stdout.trim();
}

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

async function fixture(t, tool = 'agent-cockpit', location = 'checkout') {
  const { directory } = temporaryDirectory(t, 'apply-checkouts-fixture-');
  const remote = path.join(directory, 'remote.git');
  const seed = path.join(directory, 'seed');
  const clone = path.join(directory, location);
  await git(directory, 'init', '--bare', '--initial-branch=main', remote);
  await git(directory, 'clone', remote, seed);
  await git(seed, 'config', 'user.email', 'test@example.invalid');
  await git(seed, 'config', 'user.name', 'Test');
  await write(path.join(seed, 'package.json'), { name: tool, version: '1.0.0' });
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', '初版');
  await git(seed, 'push', 'origin', 'main');
  await fs.mkdir(path.dirname(clone), { recursive: true });
  await git(directory, 'clone', remote, clone);
  await git(clone, 'config', 'user.email', 'test@example.invalid');
  await git(clone, 'config', 'user.name', 'Test');
  const root = tool === 'agent-cockpit' ? clone : path.join(directory, 'cockpit');
  if (root !== clone) {
    await write(path.join(root, 'package.json'), { name: 'agent-cockpit', version: '1.0.0' });
    await git(clone, 'remote', 'set-url', 'origin', `https://github.com/ktysne/${tool}.git`);
    await git(clone, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    await git(clone, 'config', 'url.' + remote.replace(/\\/g, '/') + '.insteadOf', `https://github.com/ktysne/${tool}.git`);
  }
  const options = { root, userHome: path.join(directory, 'home'), cwd: root, environment: {}, distributionUrl: remote,
    execFile: executeIsolated };
  return { directory, remote, seed, clone, root, options, tool };
}

async function advance(f, version = '1.0.1') {
  await write(path.join(f.seed, 'package.json'), { name: f.tool, version });
  await git(f.seed, 'add', '.');
  await git(f.seed, 'commit', '-m', '次の版');
  await git(f.seed, 'push', 'origin', 'main');
  return git(f.seed, 'rev-parse', 'HEAD');
}

async function run(f, args) {
  let output;
  const code = await main(['--update-checkouts', ...args, '--json'], { ...f.options, log: value => { output = value; } });
  return { code, report: JSON.parse(output) };
}

for (const tool of ['agent-cockpit', 'claude-codex-bridge', 'ai-cross-review']) {
  test(`${tool} の遅れを確認して選択すると main へ fast-forward する`, async t => {
    const f = await fixture(t, tool);
    const before = await git(f.clone, 'rev-parse', 'HEAD');
    const target = await advance(f);
    const checked = await run(f, ['--check']);
    const item = checked.report.checkouts.find(item => item.tool === tool);
    assert.equal(item.status, 'updatable');
    assert.match(item.commits.join('\n'), /次の版/);
    assert.equal(await git(f.clone, 'rev-parse', 'HEAD'), before);
    const updated = await run(f, ['--tool', tool]);
    assert.equal(updated.code, 0);
    assert.equal(updated.report.checkouts[0].status, 'updated');
    assert.equal(await git(f.clone, 'rev-parse', 'HEAD'), target);
    assert.equal(await git(f.clone, 'rev-parse', 'origin/main'), target);
    assert.ok(updated.report.manual.length);
    assert.equal((await run(f, ['--tool', tool])).report.checkouts[0].status, 'up-to-date');
  });
}

for (const state of ['dirty', 'branch', 'local']) {
  test(`${state} の checkout は確認と更新を拒み HEAD と変更を保つ`, async t => {
    const f = await fixture(t);
    await advance(f);
    if (state === 'dirty') await write(path.join(f.clone, 'local.txt'), '保存する変更');
    if (state === 'branch') await git(f.clone, 'switch', '-c', 'feature');
    if (state === 'local') {
      await write(path.join(f.clone, 'local.txt'), 'ローカルのコミット');
      await git(f.clone, 'add', '.');
      await git(f.clone, 'commit', '-m', 'ローカル');
    }
    const before = await git(f.clone, 'rev-parse', 'HEAD');
    for (const args of [['--check'], ['--tool', 'agent-cockpit']]) {
      const result = await run(f, args);
      assert.equal(result.code, 1);
      assert.equal(result.report.checkouts[0].status, 'blocked');
      assert.equal(await git(f.clone, 'rev-parse', 'HEAD'), before);
    }
    if (state === 'dirty') assert.equal(await fs.readFile(path.join(f.clone, 'local.txt'), 'utf8'), '保存する変更');
  });
}

test('Claude の worktree の agent-cockpit は更新を拒む', async t => {
  const f = await fixture(t, 'agent-cockpit', '.CLAUDE/WORKTREES/task');
  const before = await git(f.clone, 'rev-parse', 'HEAD');
  const result = await run(f, ['--tool', 'agent-cockpit']);
  assert.equal(result.code, 1);
  assert.equal(result.report.checkouts[0].status, 'blocked');
  assert.equal(await git(f.clone, 'rev-parse', 'HEAD'), before);
});

for (const valid of [true, false]) {
  test(`リリース追従はタグの版が${valid ? '一致すれば更新する' : '違えば失敗する'}`, async t => {
    const f = await fixture(t);
    await git(f.clone, 'tag', 'v1.0.0');
    const before = await git(f.clone, 'rev-parse', 'HEAD');
    const target = await advance(f, valid ? '1.0.2' : '1.0.1');
    await git(f.seed, 'tag', 'v1.0.2');
    await git(f.seed, 'push', 'origin', 'v1.0.2');
    await advance(f, '1.0.3');
    const result = await run(f, ['--tool', 'agent-cockpit']);
    assert.equal(result.code, valid ? 0 : 1);
    assert.equal(result.report.checkouts[0].track, 'release');
    assert.equal(result.report.checkouts[0].status, valid ? 'updated' : 'failed');
    assert.equal(await git(f.clone, 'rev-parse', 'HEAD'), valid ? target : before);
  });
}

test('導入の印があると checkout が無いツールを報告し未導入は出さない', async t => {
  const f = await fixture(t);
  assert.deepEqual((await run(f, ['--check'])).report.checkouts.map(item => item.tool), ['agent-cockpit']);
  await write(path.join(f.options.userHome, '.claude/tools/codex-agent.sh'), 'bridge');
  await write(path.join(f.options.userHome, '.claude/skills/cross-review/SKILL.md'), 'review');
  const result = await run(f, ['--check']);
  assert.equal(result.code, 1);
  assert.deepEqual(result.report.checkouts.slice(1).map(item => item.status), ['not-found', 'not-found']);
});

for (const args of [['--check', '--tool', 'agent-cockpit'], ['--from', 'input.json'], ['--item', 'item'], [], ['--tool', 'unknown']]) {
  test(`更新の不正な引数 ${args.join(' ')} は終了コード 2 にする`, async () => {
    const result = await run({ options: {} }, args);
    assert.equal(result.code, 2);
  });
}
