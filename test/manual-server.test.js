const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { request: sendRequest, startTestServer } = require('./support/server');
const { temporaryDirectory } = require('./support/temp');

function writeFile(root, relativePath, content) {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function request(port, requestPath, headers = {}, method = 'GET') {
  return sendRequest(port, { path: requestPath, headers, method });
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
}

async function runningServer(t, { manualDir } = {}) {
  const server = await startTestServer(t, {
    manualDir,
    truncateLog: false,
    temporaryPrefix: 'agent-cockpit-manual-server-',
  });
  return server.runtime;
}

function makeManual(t) {
  const root = temporaryDirectory(t, 'agent-cockpit-manual-files-').directory;
  writeFile(root, 'dist/index.html', '<!doctype html><html><body><h1>Manual fixture</h1></body></html>');
  writeFile(root, 'dist/settings.html', '<!doctype html><h1>Settings</h1></html>');
  writeFile(root, 'dist/assets/manual.css', 'body { color: red; }');
  writeFile(root, 'dist/assets/manual.js', 'window.ready = true;');
  writeFile(root, 'dist/assets/search-index.js', 'window.manualSearchIndex = [];');
  writeFile(root, 'dist/assets/private.json', '{"secret":true}');
  writeFile(root, 'img/guide/main.png', Buffer.from([137, 80, 78, 71, 0]));
  writeFile(root, 'img/guide/main.json', '{"parts":[]}');
  return root;
}

test('GET /manual/ は index.html を返し、/manual は /manual/ へ転送する。どちらも共通ヘッダを付ける', async t => {
  const manualDir = makeManual(t);
  const runtime = await runningServer(t, { manualDir });
  const directoryResponse = await request(runtime.info.port, '/manual/');
  const shortResponse = await request(runtime.info.port, '/manual');
  assert.equal(directoryResponse.status, 200);
  assert.match(directoryResponse.body, /Manual fixture/);
  assert.equal(directoryResponse.headers['content-type'], 'text/html; charset=utf-8');
  assertSecurityHeaders(directoryResponse);
  assert.equal(shortResponse.status, 308);
  assert.equal(shortResponse.headers.location, '/manual/');
  assertSecurityHeaders(shortResponse);
});

test('マニュアルは HTML、CSS、JavaScript、PNG だけを配る', async t => {
  const manualDir = makeManual(t);
  const runtime = await runningServer(t, { manualDir });
  const css = await request(runtime.info.port, '/manual/assets/manual.css');
  const script = await request(runtime.info.port, '/manual/assets/manual.js');
  const searchIndex = await request(runtime.info.port, '/manual/assets/search-index.js');
  const image = await request(runtime.info.port, '/manual/img/guide/main.png');
  const json = await request(runtime.info.port, '/manual/img/guide/main.json');
  const privateJson = await request(runtime.info.port, '/manual/assets/private.json');
  const text = await request(runtime.info.port, '/manual/readme.txt');
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(script.status, 200);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(searchIndex.status, 200);
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  for (const response of [json, privateJson, text]) {
    assert.equal(response.status, 404);
    assertSecurityHeaders(response);
  }
});

test('危険な manual path を拒否する', async t => {
  const manualDir = makeManual(t);
  const runtime = await runningServer(t, { manualDir });
  const paths = [
    '/manual/../manual/index.html',
    '/manual/%2e%2e/manual/index.html',
    '/manual//index.html',
    '/manual\\index.html',
    '/manual/img%2fguide/main.png',
    '/manual/img%5cguide/main.png',
  ];
  for (const requestPath of paths) {
    const response = await request(runtime.info.port, requestPath);
    assert.equal(response.status, 404, requestPath);
    assertSecurityHeaders(response);
  }
});

test('マニュアルの要求も Host を照合し、書き込みを受け付けない', async t => {
  const manualDir = makeManual(t);
  const runtime = await runningServer(t, { manualDir });
  const invalidHost = await request(runtime.info.port, '/manual/', { host: 'example.com' });
  const post = await request(runtime.info.port, '/manual/', {}, 'POST');
  assert.equal(invalidHost.status, 400);
  assertSecurityHeaders(invalidHost);
  assert.equal(post.status, 404);
  assertSecurityHeaders(post);
});

test('既定の manual/ から一時 home の常駐サーバーで入口を取得できる', async t => {
  const runtime = await runningServer(t);
  const response = await request(runtime.info.port, '/manual/');
  assert.equal(response.status, 200);
  assert.match(response.body, /Agent Cockpit でできること/);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
});
