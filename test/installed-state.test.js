const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { temporaryDirectory } = require('./support/temp');
const { startTestServer, request, jsonBody } = require('./support/server');

async function installedServer(t, options = {}) {
  const { directory: sourceRoot } = temporaryDirectory(t);
  const webPath = path.join(sourceRoot, 'index.html');
  await fs.writeFile(webPath, '<meta name="cockpit-ui-version" content="">first');
  await fs.writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ version: '1.4.0' }));
  await fs.mkdir(path.join(sourceRoot, '.git'));
  await fs.writeFile(path.join(sourceRoot, '.git/HEAD'), 'a'.repeat(40));
  let now = Date.now();
  const server = await startTestServer(t, { sourceRoot, webPath, appVersion: '1.4.0',
    readSourceCommit: undefined, stateCacheNow: () => now, ...options });
  return { ...server, sourceRoot, webPath, advance: () => { now += 5_000; },
    page: () => request(server.info.port, { path: '/' }),
    state: async etag => request(server.info.port, { path: '/api/state', headers: etag ? { 'if-none-match': etag } : {} }),
  };
}

for (const dev of [false, true]) {
  test(dev ? 'dev は画面と版をディスクに追従させ、画面だけの差を再起動待ちにしない' : '本番は最初の GET 前の更新でも起動時の画面と版を配信し続ける', async t => {
    const server = await installedServer(t, { dev });
    const before = jsonBody(await server.state());
    await fs.writeFile(server.webPath, '<meta name="cockpit-ui-version" content="">second');
    const page = await server.page();
    assert.match(page.body, dev ? /second/ : /first/);
    server.advance();
    const after = jsonBody(await server.state());
    const served = page.body.match(/content="([a-f0-9]{16})"/)[1];
    assert.equal(after.uiVersion, served);
    assert.notEqual(after.installed.uiVersion, before.installed.uiVersion);
    assert.equal(after.restartRequired, !dev);
    assert.equal(after.uiVersion === before.uiVersion, !dev);
  });
}

for (const field of ['version', 'commit']) {
  test(`配置済みの ${field} の変更を条件付き取得で返し再起動待ちにする`, async t => {
    const server = await installedServer(t);
    const before = await server.state();
    const file = path.join(server.sourceRoot, field === 'version' ? 'package.json' : '.git/HEAD');
    await fs.writeFile(file, field === 'version' ? '{"version":"1.5.0"}' : 'b'.repeat(40));
    assert.equal((await server.state(before.headers.etag)).status, 304);
    server.advance();
    const response = await server.state(before.headers.etag);
    assert.equal(response.status, 200);
    const after = jsonBody(response);
    assert.equal(after.restartRequired, true);
    assert.notEqual(after.installed[field], after.runtime[field]);
  });
}

test('配置済みの値を読めない場合は null とし再起動待ちにしない', async t => {
  const server = await installedServer(t);
  await server.state();
  await fs.writeFile(path.join(server.sourceRoot, 'package.json'), 'broken JSON');
  await fs.unlink(path.join(server.sourceRoot, '.git/HEAD'));
  await fs.unlink(server.webPath);
  server.advance();
  const after = jsonBody(await server.state());
  assert.deepEqual(after.installed, { version: null, commit: null, uiVersion: null });
  assert.equal(after.restartRequired, false);
  assert.match((await server.page()).body, /first/);
});

test('実行中のコミットが不明なら配置済みと比較しない', async t => {
  const server = await installedServer(t, { readSourceCommit: async () => null });
  const state = jsonBody(await server.state());
  assert.equal(state.runtime.commit, null);
  assert.equal(state.installed.commit, 'a'.repeat(40));
  assert.equal(state.restartRequired, false);
});


test('dev の状態 API は GET / を挟まなくても確認期限後に画面の版を更新する', async t => {
  const server = await installedServer(t, { dev: true });
  const before = await server.state();
  await fs.writeFile(server.webPath, 'new HTML');
  server.advance();
  const response = await server.state(before.headers.etag);
  assert.equal(response.status, 200);
  const after = jsonBody(response);
  assert.notEqual(after.uiVersion, jsonBody(before).uiVersion);
  assert.equal(after.uiVersion, after.installed.uiVersion);
  assert.equal(after.restartRequired, false);
});
