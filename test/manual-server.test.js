const test = require('node:test');
const assert = require('node:assert/strict');
const { request: sendRequest, startTestServer } = require('./support/server');

test('常駐サーバーはマニュアルを配らず、/manual/ は 404 を返す', async t => {
  const { runtime } = await startTestServer(t, { truncateLog: false, temporaryPrefix: 'agent-cockpit-manual-server-' });
  for (const path of ['/manual', '/manual/', '/manual/index.html', '/manual/img/overview/kind.png']) {
    const response = await sendRequest(runtime.info.port, { path, method: 'GET' });
    assert.equal(response.status, 404, path);
  }
});
