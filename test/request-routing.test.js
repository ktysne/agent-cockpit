const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_BODY_BYTES } = require('../src/server/server');
const { jsonBody, request, startTestServer } = require('./support/server');

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
};
const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';

// auth: hook は secret と Origin 不在、ui は uiSecret と必須の Origin、
// ui-optional-origin は uiSecret と(あれば一致する)Origin。
// nullBody は本文が null のときと [] のときの応答。口ごとに検査の位置が違うので口ごとに持つ。
const INVALID_REQUEST = { status: 400, error: 'Invalid request' };
const WRITE_ROUTES = [
  { path: '/api/hooks/answers', auth: 'hook', nullBody: INVALID_REQUEST },
  { path: '/api/decisions/decision-1/answer', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/pull-requests/review-skip', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/pull-requests/merge', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/pull-requests/reserve', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/pull-requests/cancel-reservation', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/pull-requests/conflict-request', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/record-deletions', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/hidden-sessions', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/display', auth: 'ui', nullBody: { status: 400, error: 'Invalid display preferences' } },
  { path: '/api/pull-requests/merge-result/close', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/seen', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/closed-tasks', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/closed-decisions', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/closed-agents', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/away', auth: 'ui-optional-origin', nullBody: INVALID_REQUEST },
  { path: '/api/routing', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/open-url', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/update/check', auth: 'ui', nullBody: INVALID_REQUEST },
  { path: '/api/events', auth: 'hook', nullBody: { status: 500, error: 'Internal Server Error' }, arrayBody: { status: 202 } },
  { path: '/api/sessions/session-a/plan', auth: 'hook', nullBody: INVALID_REQUEST },
  { path: '/api/sessions/session-a/prs', auth: 'hook', nullBody: INVALID_REQUEST },
];
// 本文を読まない口。
const ESTIMATE_ROUTE = { path: '/api/sessions/session-a/estimate', auth: 'ui' };
const ALL_POST_ROUTES = [...WRITE_ROUTES, ESTIMATE_ROUTE];

function assertSecurityHeaders(response, label) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(response.headers[name], value, `${label}: ${name}`);
  }
}

function assertJsonError(response, status, error, label) {
  assert.equal(response.status, status, label);
  assert.equal(response.headers['content-type'], JSON_TYPE, `${label}: content-type`);
  assert.deepEqual(jsonBody(response), { error }, label);
  assertSecurityHeaders(response, label);
}

function assertText(response, status, body, label) {
  assert.equal(response.status, status, label);
  assert.equal(response.headers['content-type'], TEXT_TYPE, `${label}: content-type`);
  assert.equal(response.body, body, label);
  assertSecurityHeaders(response, label);
}

function writer(runtimeInfo) {
  const origin = `http://127.0.0.1:${runtimeInfo.port}`;
  const secretFor = (route) => route.auth === 'hook' ? runtimeInfo.secret : runtimeInfo.uiSecret;
  const otherSecretFor = (route) => route.auth === 'hook' ? runtimeInfo.uiSecret : runtimeInfo.secret;
  const send = (route, { headers = {}, body = '{}', method = 'POST' } = {}) => request(runtimeInfo.port, {
    method, path: route.path, body, headers: { 'content-type': 'application/json', ...headers },
  });
  // 照合を通る組み合わせ。Origin が要る口にだけ付ける。
  const authorized = (route) => ({
    'x-cockpit-secret': secretFor(route),
    ...(route.auth === 'ui' ? { origin } : {}),
  });
  return { origin, secretFor, otherSecretFor, send, authorized };
}

test('すべての POST 口で、秘密値と Origin の組み合わせごとに 401、403、通過を分ける', async (t) => {
  const { info } = await startTestServer(t);
  const { origin, secretFor, otherSecretFor, send } = writer(info);
  const foreignOrigin = 'http://127.0.0.1:1';

  for (const route of ALL_POST_ROUTES) {
    const label = `${route.path} (${route.auth})`;
    const unauthorized = (response, name) => assertJsonError(response, 401, 'Unauthorized', `${label}: ${name}`);
    const forbidden = (response, name) => assertJsonError(response, 403, 'Forbidden', `${label}: ${name}`);
    const passed = (response, name) => {
      assert.ok(![401, 403].includes(response.status), `${label}: ${name} は照合を通る (${response.status})`);
      assertSecurityHeaders(response, `${label}: ${name}`);
    };

    unauthorized(await send(route), '秘密値なし');
    unauthorized(await send(route, { headers: { 'x-cockpit-secret': 'wrong-secret' } }), '誤った秘密値');
    unauthorized(await send(route, { headers: { 'x-cockpit-secret': otherSecretFor(route) } }), 'secret と uiSecret の取り違え');
    unauthorized(await send(route, { headers: { 'x-cockpit-secret': otherSecretFor(route), origin } }), '取り違えた秘密値と正しい Origin');

    const noOrigin = await send(route, { headers: { 'x-cockpit-secret': secretFor(route) } });
    if (route.auth === 'ui') forbidden(noOrigin, '正しい秘密値で Origin なし');
    else passed(noOrigin, '正しい秘密値で Origin なし');

    forbidden(await send(route, {
      headers: { 'x-cockpit-secret': secretFor(route), 'sec-fetch-site': 'cross-site', ...(route.auth === 'hook' ? {} : { origin }) },
    }), 'sec-fetch-site: cross-site');
    forbidden(await send(route, {
      headers: { 'x-cockpit-secret': secretFor(route), origin: foreignOrigin },
    }), '別の Origin');

    const rightOrigin = await send(route, { headers: { 'x-cockpit-secret': secretFor(route), origin } });
    if (route.auth === 'hook') forbidden(rightOrigin, '正しい秘密値と正しい Origin');
    else passed(rightOrigin, '正しい秘密値と正しい Origin');
  }
});

test('/api/away だけは Origin が無くても、localhost の Origin でも通る', async (t) => {
  const { info } = await startTestServer(t);
  const { send } = writer(info);
  const route = { path: '/api/away' };
  const headers = { 'x-cockpit-secret': info.uiSecret };

  assert.equal((await send(route, { headers, body: JSON.stringify({ enabled: false }) })).status, 200);
  const local = await send(route, {
    headers: { ...headers, origin: `http://localhost:${info.port}` }, body: JSON.stringify({ enabled: false }),
  });
  assert.equal(local.status, 200);
  assert.equal((await send(route, { headers: { ...headers, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ enabled: false }) })).status, 200);
});

test('GET の口は秘密値も Origin も求めない', async (t) => {
  const { info } = await startTestServer(t);
  for (const path of ['/health', '/api/state', '/api/away', '/api/sessions/session-a/context', '/']) {
    const response = await request(info.port, { path, headers: { origin: 'https://other.example', 'sec-fetch-site': 'cross-site' } });
    assert.equal(response.status, 200, path);
    assertSecurityHeaders(response, path);
  }
});

test('本文を読む口は、64KB 超を 413、壊れた JSON を 400 にし、JSON でない本文は口ごとに応える', async (t) => {
  const { info } = await startTestServer(t);
  const { authorized, send } = writer(info);

  for (const route of WRITE_ROUTES) {
    const label = `${route.path} (${route.auth})`;
    const headers = authorized(route);

    assertJsonError(await send(route, { headers, body: 'x'.repeat(MAX_BODY_BYTES + 1) }), 413, 'Payload too large', `${label}: 64KB 超`);
    assertJsonError(await send(route, { headers, body: '{' }), 400, 'Invalid JSON', `${label}: 壊れた JSON`);

    const nullBody = await send(route, { headers, body: 'null' });
    assertJsonError(nullBody, route.nullBody.status, route.nullBody.error, `${label}: null`);
    const arrayBody = await send(route, { headers, body: '[]' });
    const expectedArray = route.arrayBody || route.nullBody;
    assert.equal(arrayBody.status, expectedArray.status, `${label}: []`);
    if (expectedArray.error) assertJsonError(arrayBody, expectedArray.status, expectedArray.error, `${label}: []`);
    else assertSecurityHeaders(arrayBody, `${label}: []`);
  }
});

test('estimate は本文を読まず、送られた本文を無視する', async (t) => {
  const { info } = await startTestServer(t);
  const { authorized, send } = writer(info);
  const headers = authorized(ESTIMATE_ROUTE);

  for (const body of ['x'.repeat(MAX_BODY_BYTES + 1), '{', 'null', '[]', '']) {
    assertJsonError(await send(ESTIMATE_ROUTE, { headers, body }), 404, 'Session not found', `estimate 本文 ${body.slice(0, 5)}`);
  }
});

test('照合の前に、Host 以外の検査で応答を変えない', async (t) => {
  const { info } = await startTestServer(t);
  const { origin, send } = writer(info);

  const wrongHost = await send(ESTIMATE_ROUTE, {
    headers: { host: `example.test:${info.port}`, 'x-cockpit-secret': info.uiSecret, origin },
  });
  assertText(wrongHost, 400, 'Invalid Host', '誤った Host と正しい秘密値');
  assertText(await request(info.port, { path: '/api/state', headers: { host: 'example.test' } }), 400, 'Invalid Host', 'GET の誤った Host');

  const invalidSessionRoutes = [
    { path: '/api/sessions/bad_id/plan', auth: 'hook' },
    { path: '/api/sessions/bad_id/prs', auth: 'hook' },
    { path: '/api/sessions/bad.id/estimate', auth: 'ui' },
  ];
  for (const route of invalidSessionRoutes) {
    assertJsonError(await send(route), 401, 'Unauthorized', `${route.path}: 不正な ID と秘密値なし`);
    assertJsonError(await send(route, { headers: { 'x-cockpit-secret': route.auth === 'hook' ? info.uiSecret : info.secret } }),
      401, 'Unauthorized', `${route.path}: 不正な ID と取り違えた秘密値`);
  }
  const { authorized } = writer(info);
  assertJsonError(await send(invalidSessionRoutes[0], { headers: authorized(invalidSessionRoutes[0]) }), 400, 'Invalid session id', 'plan: 不正な ID');
  assertJsonError(await send(invalidSessionRoutes[1], { headers: authorized(invalidSessionRoutes[1]) }), 400, 'Invalid session id', 'prs: 不正な ID');
  assertJsonError(await send(invalidSessionRoutes[2], { headers: authorized(invalidSessionRoutes[2]) }), 404, 'Session not found', 'estimate: 不正な ID');

  // ID の検査は本文より先に行う。
  assertJsonError(await send(invalidSessionRoutes[0], { headers: authorized(invalidSessionRoutes[0]), body: '{' }), 400, 'Invalid session id', 'plan: 不正な ID と壊れた JSON');
  assertJsonError(await send(invalidSessionRoutes[1], { headers: authorized(invalidSessionRoutes[1]), body: '{' }), 400, 'Invalid session id', 'prs: 不正な ID と壊れた JSON');

  const huge = 'x'.repeat(MAX_BODY_BYTES + 1);
  for (const route of WRITE_ROUTES) {
    assertJsonError(await send(route, { body: huge }), 401, 'Unauthorized', `${route.path}: 巨大な本文と秘密値なし`);
  }
  assertJsonError(await send(WRITE_ROUTES.find((route) => route.path === '/api/display'), { body: '{' }), 401, 'Unauthorized', '壊れた JSON と秘密値なし');
});

test('decision id の復号失敗は、本文を読んだ後に判定する', async (t) => {
  const { info } = await startTestServer(t);
  const { authorized, send } = writer(info);
  const route = { path: '/api/decisions/%E0%A4%A/answer', auth: 'ui' };
  const headers = authorized(route);

  assertJsonError(await send(route, { headers, body: '{' }), 400, 'Invalid JSON', '壊れた JSON');
  assertJsonError(await send(route, { headers, body: 'x'.repeat(MAX_BODY_BYTES + 1) }), 413, 'Payload too large', '64KB 超');
  assertJsonError(await send(route, { headers, body: '{}' }), 400, 'Invalid decision id', '正しい JSON');
  assertJsonError(await send(route, { headers, body: 'null' }), 400, 'Invalid decision id', 'null');
  assertJsonError(await send(route), 401, 'Unauthorized', '秘密値なし');
});

test('口の無い要求は、/api/ なら 405、それ以外は 404 を text で返す', async (t) => {
  const { info } = await startTestServer(t);
  const { send } = writer(info);

  assertText(await request(info.port, { path: '/api/unknown' }), 405, 'Method Not Allowed', 'GET /api/unknown');
  assertText(await request(info.port, { method: 'POST', path: '/api/unknown', body: '{}' }), 405, 'Method Not Allowed', 'POST /api/unknown');
  assertText(await request(info.port, { method: 'POST', path: '/api/sessions/x/context', body: '{}' }), 405, 'Method Not Allowed', 'POST context');
  assertText(await request(info.port, { method: 'POST', path: '/api/state', body: '{}' }), 405, 'Method Not Allowed', 'POST /api/state');
  assertText(await request(info.port, { path: '/api/hooks/answers' }), 405, 'Method Not Allowed', 'GET /api/hooks/answers');
  assertText(await request(info.port, { method: 'PUT', path: '/api/away', body: '{}' }), 405, 'Method Not Allowed', 'PUT /api/away');
  assertText(await request(info.port, { method: 'DELETE', path: '/api/seen' }), 405, 'Method Not Allowed', 'DELETE /api/seen');
  assertText(await request(info.port, { path: '/unknown' }), 404, 'Not Found', 'GET /unknown');
  assertText(await request(info.port, { method: 'POST', path: '/', body: '{}' }), 404, 'Not Found', 'POST /');
  assertText(await request(info.port, { method: 'POST', path: '/health', body: '{}' }), 404, 'Not Found', 'POST /health');
  assertText(await request(info.port, { path: '/api/dev/fields' }), 404, 'Not Found', 'dev なしの /api/dev/fields');
  assertText(await request(info.port, { path: '/api/dev/' }), 405, 'Method Not Allowed', 'GET /api/dev/');
  assertText(await request(info.port, { path: '/api/sessions/x/context/extra' }), 405, 'Method Not Allowed', 'context の下');
  assertText(await send({ path: '/api/sessions/a/b/plan' }), 405, 'Method Not Allowed', '階層の多い plan');
});

test('/health は起動時の識別とバージョンとソースの状態を返す', async (t) => {
  const { info } = await startTestServer(t);
  const response = await request(info.port, { path: '/health' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], JSON_TYPE);
  assert.deepEqual(jsonBody(response), { app: 'agent-cockpit', pid: info.pid, startedAt: info.startedAt,
    version: require('../package.json').version, commit: null, sourceState: 'unknown' });
  assertSecurityHeaders(response, '/health');
});

test('--dev のときだけ /api/dev/fields を返す', async (t) => {
  const { info } = await startTestServer(t, { dev: true });
  const response = await request(info.port, { path: '/api/dev/fields' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], JSON_TYPE);
  assertSecurityHeaders(response, '/api/dev/fields');
});

test('不正な session id の context は秘密値なしで 400 を返す', async (t) => {
  const { info } = await startTestServer(t);
  assertJsonError(await request(info.port, { path: '/api/sessions/bad_id/context' }), 400, 'Invalid session id', 'context');
  const ok = await request(info.port, { path: '/api/sessions/session-a/context' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], JSON_TYPE);
});

test('open-url の成功は本文なしの 204 で、セキュリティヘッダーを付ける', async (t) => {
  const opened = [];
  const { info } = await startTestServer(t, { openExternalUrl: async (url) => { opened.push(url); } });
  const { authorized, send } = writer(info);
  const route = { path: '/api/open-url', auth: 'ui' };

  const response = await send(route, { headers: authorized(route), body: JSON.stringify({ url: 'https://example.com/' }) });
  assert.equal(response.status, 204);
  assert.equal(response.body, '');
  assert.equal(response.headers['content-type'], undefined);
  assertSecurityHeaders(response, 'open-url 204');
  assert.deepEqual(opened, ['https://example.com/']);
});

test('open-url の起動に失敗したら 500 を返す', async (t) => {
  const { info } = await startTestServer(t, { openExternalUrl: async () => { throw new Error('launch failed'); } });
  const { authorized, send } = writer(info);
  const route = { path: '/api/open-url', auth: 'ui' };

  assertJsonError(await send(route, { headers: authorized(route), body: JSON.stringify({ url: 'https://example.com/' }) }),
    500, 'Internal Server Error', 'open-url 失敗');
});

test('GET / は HTML を text/html で返し、秘密値の meta を埋める', async (t) => {
  const { info } = await startTestServer(t);
  const response = await request(info.port, { path: '/' });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/html; charset=utf-8$/);
  assert.ok(response.body.includes(`<meta name="cockpit-secret" content="${info.uiSecret}">`));
  assertSecurityHeaders(response, 'GET /');
});
