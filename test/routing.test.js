const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RoutingState, readRouting } = require('../src/server/routing');

async function temporaryHome(t) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-routing-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  return homeDir;
}

test('経路設定を保存し、読み戻す', async (t) => {
  const homeDir = await temporaryHome(t);
  const routing = await RoutingState.load(homeDir);
  assert.deepEqual(routing.snapshot(), { agents: 'default', review: 'default' });

  await routing.set('agents', 'claude');
  await routing.set('review', 'codex');
  await routing.flush();

  assert.deepEqual(JSON.parse(await fs.readFile(path.join(homeDir, 'routing.json'), 'utf8')), {
    agents: 'claude', review: 'codex',
  });
  assert.deepEqual(await readRouting(homeDir), { agents: 'claude', review: 'codex' });
  assert.deepEqual((await RoutingState.load(homeDir)).snapshot(), { agents: 'claude', review: 'codex' });
});

test('壊れた経路設定は両方既定として読む', async (t) => {
  const homeDir = await temporaryHome(t);
  const filePath = path.join(homeDir, 'routing.json');
  for (const contents of ['{invalid', '{"agents":"claude"}', '{"agents":"claude","review":"unknown"}']) {
    await fs.writeFile(filePath, contents);
    assert.deepEqual(await readRouting(homeDir), { agents: 'default', review: 'default' });
    assert.deepEqual((await RoutingState.load(homeDir)).snapshot(), { agents: 'default', review: 'default' });
  }
});
