const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { main } = require('../src/client/doctor');
const { integrationManifest } = require('../src/shared/integration-manifest');

const ROOT = path.resolve(__dirname, '..');
const COMMIT = 'a'.repeat(40);
const SECRET = 'doctor-test-server-secret';
const ENV_SECRET = 'doctor-test-mcp-environment';

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function mcpToml(mcp) {
  return `[mcp_servers.agent-cockpit]\ncommand = ${JSON.stringify(mcp.command)}\nargs = ${JSON.stringify(mcp.args)}\n`
    + Object.entries(mcp.tools).map(([name, tool]) => `\n[mcp_servers.agent-cockpit.tools.${name}]\napproval_mode = ${JSON.stringify(tool.approval_mode)}\n`).join('');
}

async function fixture(t, providers = ['claude', 'codex'], environment = {}) {
  const directory = await fs.mkdtemp(path.join(ROOT, 'doctor-fixture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'agent-cockpit');
  const userHome = path.join(directory, 'home');
  const homes = { claude: environment.CLAUDE_CONFIG_DIR || path.join(userHome, '.claude'),
    codex: environment.CODEX_HOME || path.join(userHome, '.codex'), cockpit: environment.AGENT_COCKPIT_HOME || path.join(userHome, '.agent-cockpit') };
  await write(path.join(root, 'package.json'), { name: 'agent-cockpit', version: '1.8.0' });
  await write(path.join(root, '.git', 'HEAD'), COMMIT);
  const manifest = integrationManifest(root);
  for (const provider of providers) {
    await write(path.join(homes[provider], provider === 'claude' ? 'settings.json' : 'hooks.json'), { hooks: manifest[provider].hooks });
    if (provider === 'claude') {
      await write(path.join(environment.CLAUDE_CONFIG_DIR ? homes.claude : userHome, '.claude.json'), {
        mcpServers: { 'agent-cockpit': { ...manifest.claude.mcp, command: 'C:/Program Files/nodejs/node.exe', env: { TOKEN: ENV_SECRET } } },
      });
    } else await write(path.join(homes.codex, 'config.toml'), mcpToml(manifest.codex.mcp));
    for (const [source, destination] of Object.entries(manifest[provider].skills)) {
      await write(path.join(root, source), `スキル ${source}\n正本\n`);
      await write(path.join(homes[provider], destination), `スキル ${source}\r\n正本\r\n`);
    }
  }
  await write(path.join(homes.cockpit, 'server.json'), { port: 47821, pid: 123, startedAt: '2026-10-20T00:00:00.000Z', secret: SECRET });
  const fetchImpl = async url => ({ ok: true, status: 200, json: async () => url.endsWith('/health')
    ? { app: 'agent-cockpit', pid: 123, startedAt: '2026-10-20T00:00:00.000Z', version: '1.8.0', commit: COMMIT, sourceState: 'release' }
    : url.includes('?run=') ? { entries: [{ msg: 'mcp.write', data: { version: '1.8.0', commit: COMMIT } }] }
      : { runs: [{ id: 'current-run', current: true }, { id: 'old-run', current: false }] } });
  const options = { root, userHome, environment, fetchImpl, readSourceState: async () => 'release' };
  return { directory, root, userHome, homes, manifest, options };
}

async function addRouteHooks(f) {
  await changeHooks(f, 'claude', hooks => {
    hooks.SubagentStart.push(structuredClone(f.manifest.claude.routeHooks.SubagentStart[0]));
    hooks.PreToolUse.push(structuredClone(f.manifest.claude.routeHooks.PreToolUse[0]));
  });
}

async function run(options, argv = ['--json']) {
  let output = '';
  const code = await main(argv, { ...options, log: text => { output += text; }, logError: text => { output += text; } });
  return { code, output, report: argv.includes('--json') ? JSON.parse(output) : null };
}

async function changeHooks(f, provider, change) {
  const file = path.join(f.homes[provider], provider === 'claude' ? 'settings.json' : 'hooks.json');
  const settings = JSON.parse(await fs.readFile(file, 'utf8'));
  change(settings.hooks);
  await write(file, settings);
  return file;
}

for (const providers of [['claude'], ['codex'], ['claude', 'codex']]) {
  test(`${providers.join(' と ')} の正常な導入は絶対パスの node と行末の違いを許容する`, async t => {
    const f = await fixture(t, providers);
    const { code, report } = await run(f.options);
    assert.equal(code, 0);
    assert.equal(report.summary.mismatch, 0);
    assert.equal(report.items.find(item => item.id === 'cockpit.checkout.state').result, 'not-run');
    assert.equal(report.items.find(item => item.category === 'server').result, 'ok');
    assert.equal(report.items.find(item => item.category === 'mcp-runtime').result, 'ok');
    assert.equal(report.summary.notInstalled, 2 - providers.length);
  });
}

for (const provider of ['claude', 'codex']) {
  test(`${provider} の timeout とイベントの不足と余分な登録を個別の不一致にする`, async t => {
    const f = await fixture(t, [provider]);
    await changeHooks(f, provider, hooks => {
      hooks.SessionStart[1].hooks[0].timeout = 4;
      delete hooks.SessionEnd;
      hooks.Unexpected = [structuredClone(hooks.SessionStart[0])];
    });
    const { code, report } = await run(f.options);
    assert.equal(code, 1);
    const ids = report.items.filter(item => item.result === 'mismatch').map(item => item.id);
    assert.deepEqual(ids, [`${provider}.hooks.SessionStart.all.away`, `${provider}.hooks.SessionEnd.all.event`, `${provider}.hooks.extra.Unexpected.event.0`]);
  });

  test(`${provider} のフックの対処は matcher とスクリプトと観測したファイルのハッシュを持つ`, async t => {
    const f = await fixture(t, [provider]);
    const file = await changeHooks(f, provider, hooks => { hooks.PreToolUse[1].hooks[0].timeout = 1; });
    const { report } = await run(f.options);
    const item = report.items.find(item => item.result === 'mismatch');
    const action = item.actions[0];
    assert.equal(action.op, 'json-replace');
    assert.deepEqual(action.path, ['hooks', 'PreToolUse']);
    assert.equal(action.match.matcher, f.manifest[provider].hooks.PreToolUse[1].matcher);
    assert.match(action.match.script.replace(/\\/g, '/'), /\/src\/hooks\/away.js$/);
    assert.equal(action.observedDigest, createHash('sha256').update(await fs.readFile(file)).digest('hex'));
    assert.ok(item.actions.some(action => action.op === 'manual' && action.text.includes('新しいセッション')));
    if (provider === 'codex') assert.ok(item.actions.some(action => action.op === 'manual' && action.text.includes('/hooks')));
  });
}

test('別の checkout を指すフックを不一致にする', async t => {
  const f = await fixture(t, ['claude']);
  const otherRoot = path.join(f.directory, 'other');
  await write(path.join(otherRoot, 'package.json'), { name: 'agent-cockpit' });
  await changeHooks(f, 'claude', hooks => { hooks.SessionStart[0].hooks[0].args = [`${otherRoot.replace(/\\/g, '/')}/src/hooks/event.js`]; });
  const { code, report } = await run(f.options);
  assert.equal(code, 1);
  const item = report.items.find(item => item.id === 'claude.hooks.SessionStart.all.event');
  assert.equal(item.result, 'mismatch');
  assert.match(item.reason, /別の checkout/);
});

test('matcher が無い、空、* の登録は同じものとして照合し、違う matcher は不一致にする', async t => {
  const f = await fixture(t, ['claude']);
  await addRouteHooks(f);
  await changeHooks(f, 'claude', hooks => {
    delete hooks.PreToolUse[0].matcher;
    hooks.SubagentStart.at(-1).matcher = '*';
    hooks.PreToolUse.at(-1).matcher = 'Bash';
  });
  const { code, report } = await run({ ...f.options, isBridgeInstalled: async () => true });
  assert.equal(code, 1);
  const mismatches = report.items.filter(item => item.result === 'mismatch');
  assert.deepEqual(mismatches.map(item => item.id), ['claude.hooks.PreToolUse.Bash|PowerShell.route']);
  assert.deepEqual([mismatches[0].expected.matcher, mismatches[0].observed.matcher], ['Bash|PowerShell', 'Bash']);
  assert.equal(mismatches[0].actions[0].match.matcher, 'Bash');
});

test('bridge 導入済みで route.js フックが無いと不一致にする', async t => {
  const f = await fixture(t, ['claude']);
  f.options.isBridgeInstalled = () => true;
  const { code, report } = await run(f.options);
  assert.equal(code, 1);
  assert.deepEqual(report.items.filter(item => item.result === 'mismatch').map(item => item.id), [
    'claude.hooks.SubagentStart.all.route', 'claude.hooks.PreToolUse.Bash|PowerShell.route',
  ]);
});

test('bridge 未導入で route.js フックが無くても不一致にしない', async t => {
  const f = await fixture(t, ['claude']);
  f.options.isBridgeInstalled = () => false;
  const { code, report } = await run(f.options);
  assert.equal(code, 0);
  assert.equal(report.summary.mismatch, 0);
  assert.equal(report.items.some(item => item.id.includes('.route')), false);
});

test('bridge 未導入でも登録済み route.js フックの値を照合する', async t => {
  const f = await fixture(t, ['claude']);
  f.options.isBridgeInstalled = () => false;
  await addRouteHooks(f);
  const { code, report } = await run(f.options);
  assert.equal(code, 0);
  assert.deepEqual(report.items.filter(item => item.id.includes('.route')).map(item => item.result), ['ok', 'ok']);
});

test('bridge 未導入でも route.js の timeout が違えば不一致にする', async t => {
  const f = await fixture(t, ['claude']);
  f.options.isBridgeInstalled = () => false;
  await addRouteHooks(f);
  await changeHooks(f, 'claude', hooks => { hooks.SubagentStart[1].hooks[0].timeout = 4; });
  const { code, report } = await run(f.options);
  assert.equal(code, 1);
  assert.deepEqual(report.items.filter(item => item.result === 'mismatch').map(item => item.id), ['claude.hooks.SubagentStart.all.route']);
});

test('MCP の実行先とスキルの古さと不存在を別々に報告する', async t => {
  const f = await fixture(t);
  await write(path.join(f.userHome, '.claude.json'), { mcpServers: { 'agent-cockpit': { command: 'node', args: ['/other/src/mcp/server.js'], env: { TOKEN: ENV_SECRET } } } });
  await write(path.join(f.homes.claude, 'skills/agent-cockpit/SKILL.md'), '古い内容');
  await fs.unlink(path.join(f.homes.codex, 'skills/agent-cockpit/SKILL.md'));
  const { code, report } = await run(f.options);
  assert.equal(code, 1);
  assert.deepEqual(report.items.filter(item => item.result === 'mismatch').map(item => item.id),
    ['claude.mcp.registration', 'claude.skills.agent-cockpit', 'codex.skills.agent-cockpit']);
  const action = report.items.find(item => item.id === 'codex.skills.agent-cockpit').actions[0];
  assert.equal(action.op, 'copy');
  assert.equal(action.observedDigest, null);
  assert.equal(action.from, 'skills/codex/agent-cockpit/SKILL.md');
  const registration = report.items.find(item => item.id === 'claude.mcp.registration').actions[0];
  assert.deepEqual(registration.digestPath, ['mcpServers', 'agent-cockpit']);
  assert.equal(registration.observedDigest, createHash('sha256').update(JSON.stringify({
    command: 'node', args: ['/other/src/mcp/server.js'], env: { TOKEN: ENV_SECRET },
  })).digest('hex'));
});

test('Codex の MCP の実行先とツールの approval_mode を別々に照合する', async t => {
  const f = await fixture(t, ['codex']);
  const mcp = structuredClone(f.manifest.codex.mcp);
  mcp.args = ['/other/src/mcp/server.js'];
  mcp.tools.cockpit_add_decision.approval_mode = 'prompt';
  await write(path.join(f.homes.codex, 'config.toml'), mcpToml(mcp));
  const { code, report } = await run(f.options);
  assert.equal(code, 1);
  assert.deepEqual(report.items.filter(item => item.result === 'mismatch').map(item => item.id), ['codex.mcp.registration', 'codex.mcp.tools.cockpit_add_decision']);
  assert.ok(report.items.find(item => item.id === 'codex.mcp.registration').actions.some(action => action.op === 'toml-set' && action.key === 'args'));
});

test('Codex の登録をインラインテーブルで書いたものは未確認にし書き換えの対処を出さない', async t => {
  const f = await fixture(t, ['codex']);
  const mcp = f.manifest.codex.mcp;
  const tools = Object.keys(mcp.tools).map(name => `${name} = { approval_mode = "approve" }`).join(', ');
  const server = `command = "node", args = ${JSON.stringify(mcp.args)}`;
  for (const toml of [
    `[mcp_servers.agent-cockpit]\ncommand = "node"\nargs = ${JSON.stringify(mcp.args)}\ntools = { ${tools} }\n`,
    `mcp_servers = { agent-cockpit = { ${server} } }\n`,
    `[mcp_servers]\nagent-cockpit = { ${server} }\n`,
  ]) {
    await write(path.join(f.homes.codex, 'config.toml'), toml);
    const { code, report } = await run(f.options);
    assert.equal(code, 0);
    const items = report.items.filter(item => item.category === 'mcp');
    assert.deepEqual(items.map(item => [item.id, item.result]), [['codex.mcp.registration', 'unverified']]);
    assert.deepEqual(items[0].actions, []);
  }
});

test('Codex の MCP の env と信頼の記録と別のプロジェクトの表は照合を妨げない', async t => {
  const f = await fixture(t, ['codex']);
  const toml = mcpToml(f.manifest.codex.mcp).replace('[mcp_servers.agent-cockpit]\n', '[mcp_servers.agent-cockpit]\nenv = { TOKEN = "value" }\n')
    + `\n[mcp_servers.agent-cockpit.env]\nOTHER = "value"\n\n[projects.'${f.root.replace(/\\/g, '/')}']\ntrust_level = "trusted"\n`
    + `\n[hooks.state.'${f.root.replace(/\\/g, '/')}/src/hooks/event.js']\ntrusted_hash = "x"\n`;
  await write(path.join(f.homes.codex, 'config.toml'), toml);
  const { code, report } = await run(f.options);
  assert.equal(code, 0);
  assert.equal(report.items.find(item => item.id === 'codex.mcp.registration').result, 'ok');
});

test('同じグループに独自のフックがある登録の対処はフック 1 件だけを置き換えるか取り除く', async t => {
  const f = await fixture(t, ['claude']);
  await changeHooks(f, 'claude', hooks => {
    hooks.SessionStart[1].hooks[0].timeout = 1;
    hooks.SessionStart[1].hooks.push({ type: 'command', command: 'private-custom-command' });
    hooks.Notification[0].hooks.push(structuredClone(hooks.SessionEnd[0].hooks[0]));
    delete hooks.SessionEnd;
  });
  const { report } = await run(f.options);
  const replaced = report.items.find(item => item.id === 'claude.hooks.SessionStart.all.away').actions[0];
  assert.deepEqual([replaced.op, replaced.target], ['json-replace', 'hook']);
  assert.deepEqual(replaced.value, f.manifest.claude.hooks.SessionStart[1].hooks[0]);
  const ended = report.items.find(item => item.id === 'claude.hooks.SessionEnd.all.event');
  assert.deepEqual([ended.actions[0].op, ended.actions[0].target], ['json-add', 'group']);
  const extra = report.items.find(item => item.id.startsWith('claude.hooks.extra.Notification.event')).actions[0];
  assert.deepEqual([extra.op, extra.target, extra.value], ['json-remove', 'hook', undefined]);
});

test('環境変数で変更した各ホームを使う', async t => {
  const base = await fs.mkdtemp(path.join(ROOT, 'doctor-homes-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const environment = { CLAUDE_CONFIG_DIR: path.join(base, 'claude'), CODEX_HOME: path.join(base, 'codex'), AGENT_COCKPIT_HOME: path.join(base, 'cockpit') };
  const f = await fixture(t, ['claude', 'codex'], environment);
  const { code, report } = await run(f.options);
  assert.equal(code, 0);
  assert.deepEqual(report.homes, f.homes);
  assert.equal(report.summary.mismatch, 0);
});

test('未導入と停止中と未実施を区別し終了コードを成功にする', async t => {
  const f = await fixture(t, []);
  const { code, report } = await run({ ...f.options, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(code, 0);
  assert.equal(report.summary.notInstalled, 2);
  assert.equal(report.items.find(item => item.category === 'server').result, 'unverified');
  assert.equal(report.items.find(item => item.category === 'mcp-runtime').result, 'unverified');
  assert.equal(report.items.find(item => item.category === 'runtime-check').result, 'not-run');
});

test('独自のフックと MCP 設定と秘密値は診断の項目や対処に出さない', async t => {
  const f = await fixture(t, ['claude']);
  await changeHooks(f, 'claude', hooks => {
    hooks.SessionStart[0].hooks.push({ type: 'command', command: 'private-custom-command' });
    hooks.Custom = [{ hooks: [{ type: 'command', command: 'private-custom-event' }] }];
    hooks.SessionStart[1].hooks[0].timeout = 1;
  });
  const file = path.join(f.userHome, '.claude.json');
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  config.mcpServers.privateCustom = { command: 'private-custom-mcp', env: { TOKEN: ENV_SECRET } };
  await write(file, config);
  const { output, report } = await run(f.options);
  for (const value of [SECRET, ENV_SECRET, 'private-custom', '"secret"', '"env"']) assert.ok(!output.includes(value));
  assert.deepEqual(report.items.filter(item => item.result === 'mismatch').map(item => item.id), ['claude.hooks.SessionStart.all.away']);
});

test('存在しない設定ファイルへの対処は全体なら null で部分木なら null のハッシュを持つ', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.homes.codex, 'hooks.json'));
  await fs.unlink(path.join(f.userHome, '.claude.json'));
  const { report } = await run(f.options);
  for (const item of report.items.filter(item => item.result === 'mismatch')) {
    for (const action of item.actions.filter(action => action.op.startsWith('json-'))) {
      assert.equal(action.observedDigest, action.digestPath ? createHash('sha256').update('null').digest('hex') : null);
    }
    if (item.provider === 'codex' && item.category === 'hooks') assert.ok(item.actions.some(action => action.text?.includes('/hooks')));
  }
});

test('更新用スキルの不存在は未導入にする', async t => {
  const f = await fixture(t, ['claude']);
  await fs.unlink(path.join(f.homes.claude, 'skills/update-tools/SKILL.md'));
  const { code, report } = await run(f.options);
  assert.equal(code, 0);
  assert.equal(report.items.find(item => item.id === 'claude.skills.update-tools').result, 'not-installed');
});

test('公開仕様でない Claude の MCP 設定が読めなくても診断を続ける', async t => {
  const f = await fixture(t, ['claude']);
  await write(path.join(f.userHome, '.claude.json'), '{壊れた設定');
  const { code, report } = await run(f.options);
  assert.equal(code, 0);
  assert.equal(report.items.find(item => item.id === 'claude.mcp.registration').result, 'unverified');
});

test('Claude のプロジェクトスコープに同名の MCP があれば未確認にする', async t => {
  const f = await fixture(t, ['claude']);
  await write(path.join(f.userHome, '.claude.json'), { mcpServers: { 'agent-cockpit': f.manifest.claude.mcp },
    projects: { [f.root]: { mcpServers: { 'agent-cockpit': { command: 'private-project-command', env: { TOKEN: ENV_SECRET } } } } } });
  const { code, output, report } = await run(f.options);
  assert.equal(code, 0);
  assert.equal(report.items.find(item => item.id === 'claude.mcp.registration').result, 'unverified');
  assert.ok(!output.includes('private-project-command'));
});

test('登録されたフックの checkout を既定の照合先にする', async t => {
  const f = await fixture(t);
  const { root, ...options } = f.options;
  const { code, report } = await run(options);
  assert.equal(code, 0);
  assert.equal(report.checkout.root, root.replace(/\\/g, '/'));
  assert.equal(report.checkout.resolvedBy, 'hooks');
});

test('provider をまたぐ複数の checkout は候補を示し診断の checkout に戻す', async t => {
  const f = await fixture(t);
  const other = path.join(f.directory, 'other');
  await write(path.join(other, 'package.json'), { name: 'agent-cockpit' });
  await changeHooks(f, 'codex', hooks => {
    hooks.SessionStart[0].hooks[0].command = `node "${other.replace(/\\/g, '/')}/src/hooks/event.js" codex`;
  });
  const { root, ...options } = f.options;
  const { code, report } = await run({ ...options, checkoutRoot: root });
  assert.equal(code, 1);
  assert.equal(report.checkout.resolvedBy, 'doctor');
  assert.deepEqual(report.items.find(item => item.id === 'claude.hooks.SessionStart.all.event').observed.checkoutCandidates,
    [root.replace(/\\/g, '/'), other.replace(/\\/g, '/')]);
});

test('--root はフックの checkout より優先し worktree の元の checkout には置き換えない', async t => {
  const f = await fixture(t, ['claude']);
  const { code, report } = await run({ ...f.options, root: undefined }, ['--json', '--root', f.root]);
  assert.equal(code, 0);
  assert.equal(report.checkout.root, f.root);
  assert.equal(report.checkout.resolvedBy, 'root');
});

test('フックが無い worktree の既定は元の checkout に戻す', async t => {
  const f = await fixture(t, []);
  const worktree = path.join(f.directory, 'worktree');
  await write(path.join(worktree, '.git'), `gitdir: ${path.join(f.root, '.git/worktrees/test').replace(/\\/g, '/')}\n`);
  const { root, ...options } = f.options;
  const { code, report } = await run({ ...options, checkoutRoot: worktree });
  assert.equal(code, 0);
  assert.equal(report.checkout.root, root);
});

test('今の起動の古い MCP の記録は開き直しを案内して未確認にする', async t => {
  const f = await fixture(t, []);
  const fetchImpl = async (url, init) => url.includes('?run=')
    ? { ok: true, status: 200, json: async () => ({ entries: [{ msg: 'mcp.write', data: { version: '1.7.0', commit: 'b'.repeat(40) } }] }) }
    : f.options.fetchImpl(url, init);
  const { code, report } = await run({ ...f.options, fetchImpl });
  assert.equal(code, 0);
  const item = report.items.find(item => item.category === 'mcp-runtime');
  assert.equal(item.result, 'unverified');
  assert.ok(item.actions.some(action => action.op === 'manual' && action.text.includes('新しいセッション')));
});

test('常駐サーバーのコミットの違いは再起動の対処を持つ', async t => {
  const f = await fixture(t, []);
  const fetchImpl = async (url, init) => {
    const response = await f.options.fetchImpl(url, init);
    const value = await response.json();
    return { ...response, json: async () => url.endsWith('/health') ? { ...value, commit: 'b'.repeat(40) } : value };
  };
  const { code, report } = await run({ ...f.options, fetchImpl });
  assert.equal(code, 1);
  assert.deepEqual(report.items.find(item => item.category === 'server').actions,
    [{ op: 'command', command: 'node src/client/restart-server.js --json', cwd: f.root }]);
});

test('人向け出力は結果を見出しで分け不一致に対処を添える', async t => {
  const f = await fixture(t, ['claude']);
  await changeHooks(f, 'claude', hooks => { hooks.SessionStart[1].hooks[0].timeout = 1; });
  const { code, output } = await run(f.options, []);
  assert.equal(code, 1);
  for (const title of ['確認できたこと', '不一致', '未確認', '未導入・対象外', '未実施', '対処:']) assert.ok(output.includes(title));
  assert.ok(!output.includes(SECRET));
});

test('診断自体が失敗した場合は終了コード 2 を返す', async t => {
  const f = await fixture(t, []);
  const { code, output } = await run(f.options, ['--json', '--root', path.join(f.directory, 'missing')]);
  assert.equal(code, 2);
  assert.ok(output.includes('診断を完了できませんでした'));
});

test('導入手順の JSON と TOML の例は共通の期待値と一致する', async () => {
  const setup = await fs.readFile(path.join(ROOT, 'docs/setup.md'), 'utf8');
  const manifest = integrationManifest('D:/path/to/agent-cockpit');
  const examples = [...setup.matchAll(/```json\r?\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));
  assert.deepEqual(examples.filter(value => value.hooks?.SessionStart).map(value => value.hooks), [manifest.claude.hooks, manifest.codex.hooks]);
  const patternC = setup.split('## パターン C: + claude-codex-bridge')[1].split('## パターン D: + ai-cross-review')[0];
  const routeExample = JSON.parse(patternC.match(/```json\r?\n([\s\S]*?)```/)[1]);
  assert.deepEqual(routeExample.hooks, manifest.claude.routeHooks);
  assert.equal(Object.hasOwn(manifest.codex, 'routeHooks'), false);
  const toml = [...setup.matchAll(/```toml\r?\n([\s\S]*?)```/g)].find(match => match[1].includes('[mcp_servers.agent-cockpit]'))[1];
  assert.equal(toml.replace(/\r\n/g, '\n').trim(), mcpToml(manifest.codex.mcp).trim());
});

async function reviewCheckout(f) {
  const root = path.join(f.directory, 'ai-cross-review');
  await write(path.join(root, '.git/config'), '[remote "origin"]\nurl = https://github.com/ktysne/ai-cross-review.git\n');
  return root;
}

test('グローバル SKILL の配布先の状態を診断と対処へ写す', async t => {
  const f = await fixture(t);
  await reviewCheckout(f);
  const results = { match: 'ok', stale: 'mismatch', missing: 'not-installed', skipped: 'not-installed', unreadable: 'unverified' };
  for (const [state, result] of Object.entries(results)) {
    const targets = ['claude', 'codex', 'codex-subagent'].map(id => ({ id, state,
      path: path.join(f.userHome, id, 'SKILL.md'), sourcePath: path.join(f.directory, 'source.md'),
      sha256: state === 'missing' ? null : 'a'.repeat(64), sourceSha256: 'b'.repeat(64) }));
    const queryCrossReview = async () => ({ stdout: JSON.stringify({ schemaVersion: 1, targets }) });
    const { report } = await run({ ...f.options, queryCrossReview });
    const items = report.items.filter(item => item.category === 'copies');
    assert.equal(items.length, targets.length);
    for (const [index, item] of items.entries()) {
      const target = targets[index];
      assert.equal(item.id, 'cross-review.skills.' + target.id);
      assert.equal(item.tool, 'ai-cross-review');
      assert.equal(item.provider, target.id === 'claude' ? 'claude' : 'codex');
      assert.equal(item.target, target.path);
      assert.equal(item.result, result);
      assert.equal(item.expected, target.sourceSha256);
      assert.equal(item.observed, target.sha256);
      assert.deepEqual(item.actions.filter(action => action.op !== 'manual'), ['stale', 'missing'].includes(state)
        ? [{ op: 'copy-file', from: target.sourcePath, to: target.path, observedDigest: target.sha256, sourceDigest: target.sourceSha256 }] : []);
      assert.equal(item.actions.some(action => action.op === 'manual'), ['stale', 'missing'].includes(state));
    }
  }
});

test('照会には解決したホームと checkout と時間切れを渡す', async t => {
  const f = await fixture(t, []);
  f.options.environment = { CLAUDE_CONFIG_DIR: path.join(f.directory, 'custom-claude'), CODEX_HOME: path.join(f.directory, 'custom-codex') };
  const root = await reviewCheckout(f);
  const queryCrossReview = async (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ['tools/cross-review.sync-all.js', '--global-skill', '--check', '--json']);
    assert.equal(options.cwd, root);
    assert.equal(options.timeout, 30000);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, f.options.environment.CLAUDE_CONFIG_DIR);
    assert.equal(options.env.CODEX_HOME, f.options.environment.CODEX_HOME);
    return { stdout: JSON.stringify({ schemaVersion: 1, targets: [] }) };
  };
  assert.equal((await run({ ...f.options, queryCrossReview })).code, 0);
});

test('照会できない各場合は写しを一つの未確認にまとめる', async t => {
  const f = await fixture(t);
  const root = await reviewCheckout(f);
  const failures = [
    async () => { throw Object.assign(new Error(), { code: 'EPERM' }); },
    async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); },
    async () => { throw Object.assign(new Error(), { killed: true }); },
    async () => { throw Object.assign(new Error(), { code: 2 }); },
    async () => { throw Object.assign(new Error(), { code: 4 }); },
    async () => ({ stdout: 'invalid' }),
    async () => ({ stdout: JSON.stringify({ schemaVersion: 2 }) }),
  ];
  for (const queryCrossReview of failures) {
    const { report } = await run({ ...f.options, queryCrossReview });
    const items = report.items.filter(item => item.category === 'copies');
    assert.equal(items.length, 1);
    assert.equal(items[0].result, 'unverified');
    assert.match(items[0].reason, /--update-checkouts --check/);
    assert.match(items[0].reason, /導入手順/);
  }
  await fs.rm(root, { recursive: true });
  await write(path.join(f.homes.claude, 'skills/cross-review/SKILL.md'), 'installed');
  const { report } = await run(f.options);
  assert.deepEqual(report.items.filter(item => item.category === 'copies').map(item => item.result), ['unverified']);
});

test('照会が終了コード 1 と 3 でも JSON の配布先を診断する', async t => {
  const f = await fixture(t);
  await reviewCheckout(f);
  for (const code of [1, 3]) {
    const queryCrossReview = async () => { throw Object.assign(new Error(), { code,
      stdout: JSON.stringify({ schemaVersion: 1, targets: [{ id: 'claude', path: f.homes.claude, state: 'unreadable', sha256: null, sourceSha256: null }] }) }); };
    const { report } = await run({ ...f.options, queryCrossReview });
    assert.deepEqual(report.items.filter(item => item.category === 'copies').map(item => item.id), ['cross-review.skills.claude']);
  }
});

test('ai-cross-review が未導入なら照会も写しの項目も作らない', async t => {
  const f = await fixture(t);
  const queryCrossReview = async () => { assert.fail('未導入の照会'); };
  const { report } = await run({ ...f.options, queryCrossReview });
  assert.deepEqual(report.items.filter(item => item.category === 'copies'), []);
});
