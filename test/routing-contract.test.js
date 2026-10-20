const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readRouting, readRoutingSync, RoutingState } = require('../src/server/routing');
const { temporaryDirectory } = require('./support/temp');

const fixtures = path.join(__dirname, '../contracts/routing');

for (const name of fs.readdirSync(path.join(fixtures, 'read')).sort()) {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'read', name), 'utf8'));
  test(`経路設定の読み取り契約: ${fixture.description}`, async (t) => {
    const { directory } = temporaryDirectory(t, 'agent-cockpit-routing-contract-');
    if (fixture.input !== null) fs.writeFileSync(path.join(directory, 'routing.json'), fixture.input);
    assert.deepEqual(await readRouting(directory), fixture.expected);
    assert.deepEqual(readRoutingSync(directory), fixture.expected);
  });
}

for (const name of fs.readdirSync(path.join(fixtures, 'write')).sort()) {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'write', name), 'utf8'));
  test(`経路設定の書き込み契約: ${fixture.description}`, async (t) => {
    const { directory } = temporaryDirectory(t, 'agent-cockpit-routing-contract-');
    fs.writeFileSync(path.join(directory, 'routing.json'), JSON.stringify(fixture.start));
    const routing = await RoutingState.load(directory);
    await routing.set(fixture.set.key, fixture.set.value);
    await routing.flush();
    assert.deepEqual(fs.readFileSync(path.join(directory, 'routing.json')), Buffer.from(fixture.expected));
  });
}
