const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer } = require('../../src/server/server');
const { temporaryHome } = require('./temp');

async function startTestServer(testContext, options = {}) {
  const {
    temporaryPrefix = 'agent-cockpit-server-test-',
    environment,
    ...serverOptions
  } = options;
  const temporary = temporaryHome(testContext, temporaryPrefix, { deferCleanup: true, environment });
  let runtime;

  try {
    runtime = await startServer({
      homeDir: temporary.homeDir,
      claudeHome: temporary.claudeHome,
      userHome: temporary.homeDir,
      port: 0,
      readSourceCommit: async () => null,
      readSourceState: () => 'unknown',
      ...serverOptions,
    });
  } catch (error) {
    await temporary.cleanup();
    throw error;
  }

  testContext.after(async () => {
    try {
      await runtime.close();
    } finally {
      await temporary.cleanup();
    }
  });

  return { ...temporary, runtime, info: runtime.info };
}

async function request(port, { method = 'GET', path: requestPath = '/', headers = {}, body = '' } = {}) {
  const requestHeaders = { ...headers };
  if (body && requestHeaders['content-length'] === undefined) {
    requestHeaders['content-length'] = Buffer.byteLength(body);
  }
  if (requestHeaders.host === undefined) requestHeaders.host = `127.0.0.1:${port}`;

  return new Promise((resolve, reject) => {
    const client = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers: requestHeaders }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: response.statusCode, body: buffer.toString('utf8'), headers: response.headers });
      });
    });
    client.once('error', reject);
    client.end(body);
  });
}

function jsonBody(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    assert.fail(`Expected JSON response, received: ${response.body}`);
  }
}

function uiHeaders(info, origin, headers = {}) {
  return {
    'x-cockpit-secret': info.uiSecret,
    ...(origin ? { origin } : {}),
    ...headers,
  };
}

function hookHeaders(secret, headers = {}) {
  return { 'x-cockpit-secret': secret, ...headers };
}

module.exports = { hookHeaders, jsonBody, request, startTestServer, uiHeaders };
