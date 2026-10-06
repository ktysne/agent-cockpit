'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  MARKERS,
  createNativeInstructionFixture,
} = require('./native-fixture');

function sendRequest(fixture, { headers = {}, input = [], host, omitToken = false } = {}) {
  const body = JSON.stringify({ model: 'fixture-test', input });
  const url = new URL(fixture.baseUrl);
  const requestHeaders = {
    ...fixture.requestHeaders,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  };
  if (omitToken) delete requestHeaders['X-Poc161-Token'];
  if (host) requestHeaders.host = host;

  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: '/v1/responses',
      method: 'POST',
      headers: requestHeaders,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function message(role, partType, text) {
  return { type: 'message', role, content: [{ type: partType, text }] };
}

function assertSecurityHeaders(headers) {
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['content-security-policy'], "frame-ancestors 'none'");
  assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(Object.keys(headers).some((name) => name.startsWith('access-control-')), false);
}

test('有効な要求はSSEを返し、完全一致したユーザー入力マーカーだけを記録する', async (t) => {
  const fixture = await createNativeInstructionFixture({ gateCount: 0 }).start();
  t.after(() => fixture.close());

  const response = await sendRequest(fixture, {
    input: [
      message('user', 'input_text', MARKERS.initial),
      message('assistant', 'input_text', MARKERS.warmup),
      message('user', 'input_text', `${MARKERS.second}_suffix`),
      message('user', 'input_text', `quoted ${MARKERS.steer} text`),
    ],
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^text\/event-stream\b/);
  assert.match(response.body, /event: response\.completed\n/);
  assertSecurityHeaders(response.headers);
  const markerHits = fixture.requests[0].marker_hits;
  assert.equal(markerHits.initial, true);
  for (const [name, hit] of Object.entries(markerHits)) {
    if (name !== 'initial') assert.equal(hit, false);
  }
});

test('APIキューとCLIキューのmarkerを別々に記録し、disconnectSteerを認識する', async (t) => {
  const fixture = await createNativeInstructionFixture({ gateCount: 0 }).start();
  t.after(() => fixture.close());

  await sendRequest(fixture, { input: [message('user', 'input_text', MARKERS.queueA)] });
  await sendRequest(fixture, {
    input: [
      message('user', 'input_text', MARKERS.queueCli),
      message('user', 'input_text', MARKERS.disconnectSteer),
    ],
  });

  const [apiQueueHits, cliQueueHits] = fixture.requests.map((request) => request.marker_hits);
  assert.equal(apiQueueHits.queueA, true);
  assert.equal(apiQueueHits.queueCli, false);
  assert.equal(cliQueueHits.queueA, false);
  assert.equal(cliQueueHits.queueCli, true);
  assert.equal(cliQueueHits.queueB, false);
  assert.equal(cliQueueHits.disconnectSteer, true);
});

test('トークン欠落・不一致、Origin付き要求、Host不一致を拒否する', async (t) => {
  const fixture = await createNativeInstructionFixture({ gateCount: 0 }).start();
  t.after(() => fixture.close());

  const noToken = await sendRequest(fixture, { omitToken: true });
  const wrongToken = await sendRequest(fixture, { headers: { 'x-poc161-token': 'invalid' } });
  const withOrigin = await sendRequest(fixture, { headers: { origin: 'http://localhost' } });
  const wrongHost = await sendRequest(fixture, { host: 'attacker.invalid' });

  for (const response of [noToken, wrongToken, withOrigin, wrongHost]) {
    assert.equal(response.statusCode, 403);
    assertSecurityHeaders(response.headers);
  }
  assert.equal(fixture.requestCount, 0);
});

test('ゲート待ちの要求はrelease後にSSE応答へ進む', async (t) => {
  const fixture = await createNativeInstructionFixture({ gateCount: 1 }).start();
  t.after(() => fixture.close());

  const responsePromise = sendRequest(fixture);
  assert.equal(await fixture.waitForGate(500), true);
  assert.equal(fixture.gateWaiting, 1);
  fixture.release();

  const response = await responsePromise;
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^text\/event-stream\b/);
});

test('gateNextはwarmup後に指定した次の要求だけを保留する', async (t) => {
  const fixture = await createNativeInstructionFixture({ gateCount: 0 }).start();
  t.after(() => fixture.close());

  const warmupResponse = await sendRequest(fixture);
  assert.equal(warmupResponse.statusCode, 200);
  assert.equal(fixture.gateWaiting, 0);

  assert.equal(fixture.gateNext(), 2);
  const nextResponsePromise = sendRequest(fixture);
  assert.equal(await fixture.waitForGate(500), true);
  assert.equal(fixture.requestCount, 2);
  assert.equal(fixture.gateWaiting, 1);
  fixture.release();

  const nextResponse = await nextResponsePromise;
  assert.equal(nextResponse.statusCode, 200);
});

test('ゲートのtimeoutは504で終わり、closeは待機中の要求を解放する', async (t) => {
  const timeoutFixture = await createNativeInstructionFixture({ gateCount: 1, timeoutMs: 1000 }).start();
  t.after(() => timeoutFixture.close());

  const timeoutRequest = sendRequest(timeoutFixture);
  assert.equal(await timeoutFixture.waitForGate(500), true);
  const timeoutResponse = await timeoutRequest;
  assert.equal(timeoutResponse.statusCode, 504);

  const closeFixture = await createNativeInstructionFixture({ gateCount: 1 }).start();
  t.after(() => closeFixture.close());
  const closeRequest = sendRequest(closeFixture).then(() => 'response', () => 'rejected');
  assert.equal(await closeFixture.waitForGate(500), true);
  await closeFixture.close();

  const settled = await Promise.race([
    closeRequest,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
  ]);
  assert.notEqual(settled, 'timeout');
});
