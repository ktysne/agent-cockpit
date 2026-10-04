const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RoutingState, readRouting, readRoutingSync } = require('../src/server/routing');
const { atomicWriteJsonSync } = require('../src/server/json-storage');

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

test('同期フックと常駐サーバーは壊れた経路設定を同じ既定値として読む', async (t) => {
  const homeDir = await temporaryHome(t);
  const filePath = path.join(homeDir, 'routing.json');
  for (const contents of ['{invalid', 'null', '[]', '{"agents":"claude","review":"unknown"}']) {
    await fs.writeFile(filePath, contents);
    assert.deepEqual(readRoutingSync(homeDir), { agents: 'default', review: 'default' });
    assert.deepEqual(readRoutingSync(homeDir), await readRouting(homeDir));
  }
});

test('同期 JSON 書き込みは EPERM と EBUSY の rename を再試行する', async (t) => {
  const homeDir = await temporaryHome(t);
  let attempts = 0;
  const delays = [];
  const fileSystem = new Proxy(fsSync, {
    get(target, property) {
      if (property === 'renameSync') return (source, destination) => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('rename busy'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
        return target.renameSync.call(target, source, destination);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  atomicWriteJsonSync(homeDir, 'route.json', { route: 'claude' }, fileSystem, {
    retryDelaysMs: [5, 10],
    delaySync: (milliseconds) => delays.push(milliseconds),
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5, 10]);
  assert.deepEqual(JSON.parse(fsSync.readFileSync(path.join(homeDir, 'route.json'), 'utf8')), { route: 'claude' });
});
