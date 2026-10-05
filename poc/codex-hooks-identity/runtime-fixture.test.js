'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createFixtureServer } = require('./runtime-fixture');

const mcpName = 'mcp__poc157_identity.probe_identity';

function postJson(url, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(data);
  });
}

function readEvents(body) {
  return body.trim().split(/\r?\n\r?\n/).map((block) => {
    const dataLine = block.split(/\r?\n/).find((line) => line.startsWith('data: '));
    return JSON.parse(dataLine.slice(6));
  });
}

function directTools() {
  return [
    {
      type: 'function',
      name: 'exec_command',
      parameters: {
        type: 'object',
        properties: { cmd: { type: 'string' }, workdir: { type: 'string' } },
        required: ['cmd'],
      },
    },
    {
      type: 'namespace',
      name: 'mcp__poc157_identity',
      tools: [{
        type: 'function',
        name: 'probe_identity',
        parameters: {
          type: 'object',
          properties: { session_id: { type: ['string', 'null'] } },
          required: ['session_id'],
        },
      }],
    },
  ];
}

test('fixture emits linked Responses tool calls and retains only allowlisted request summaries', async (t) => {
  const fixture = createFixtureServer({ mcpProbeToolName: mcpName });
  await fixture.start();
  t.after(() => fixture.close());

  assert.equal(fixture.server.address().address, '127.0.0.1');
  assert.match(fixture.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

  const first = await postJson(fixture.baseUrl + '/v1/responses', {
    model: 'fixture-model',
    instructions: 'PRIVATE_INSTRUCTIONS',
    input: [{ role: 'user', content: 'PRIVATE_PROMPT' }],
    tools: directTools(),
  }, {
    ...fixture.requestHeaders,
    Authorization: 'Bearer PRIVATE_TOKEN',
    'X-Codex-Thread-Id': 'thread-fixture-157',
  });
  assert.equal(first.status, 200);
  const events = readEvents(first.body);
  assert.deepEqual(events.map((event) => event.type), [
    'response.created',
    'response.output_item.added',
    'response.function_call_arguments.done',
    'response.output_item.done',
    'response.completed',
  ]);
  assert.deepEqual(events.map((event) => event.sequence_number), [0, 1, 2, 3, 4]);
  const added = events[1].item;
  const argumentsDone = events[2];
  const done = events[3].item;
  assert.equal(events[0].response.id, events[4].response.id);
  assert.equal(added.id, argumentsDone.item_id);
  assert.equal(added.id, done.id);
  assert.equal(added.call_id, done.call_id);
  assert.equal(done.arguments, argumentsDone.arguments);
  assert.equal(added.name, 'exec_command');
  assert.deepEqual(JSON.parse(argumentsDone.arguments), { cmd: 'Write-Output POC157; exit 7' });

  const second = await postJson(fixture.baseUrl + '/responses', { model: 'fixture-model', tools: directTools() }, fixture.requestHeaders);
  const secondEvents = readEvents(second.body);
  assert.equal(secondEvents[1].item.name, 'probe_identity');
  assert.equal(secondEvents[1].item.namespace, 'mcp__poc157_identity');
  assert.deepEqual(JSON.parse(secondEvents[2].arguments), { session_id: null });

  const third = await postJson(fixture.baseUrl + '/v1/responses', { model: 'fixture-model', tools: directTools() }, fixture.requestHeaders);
  const finalEvents = readEvents(third.body);
  assert.equal(finalEvents.at(-1).type, 'response.completed');
  assert.match(finalEvents.at(-1).response.output[0].content[0].text, /実モデルや実APIの観測結果ではありません/);

  const retained = JSON.stringify(fixture.requests);
  for (const secret of ['PRIVATE_INSTRUCTIONS', 'PRIVATE_PROMPT', 'PRIVATE_TOKEN']) assert.equal(retained.includes(secret), false);
  assert.equal(fixture.requests[0].identityHeaders['x-codex-thread-id'], 'thread-fixture-157');
  assert.ok(fixture.requests[0].headerNames.includes('authorization'));
  assert.deepEqual(fixture.requests[0].tools[0], { name: 'exec_command', schemaKeys: ['cmd', 'workdir'] });
  assert.deepEqual(fixture.requests[0].bodyShape.topLevel.find((entry) => entry.key === 'instructions'), { key: 'instructions', type: 'string' });
  assert.equal(fixture.requests[0].bodyShape.tools.type, 'array');
  assert.deepEqual(fixture.requests[0].bodyShape.tools.items[0].keys, ['name', 'parameters', 'type']);
  assert.equal(JSON.stringify(fixture.requests).includes(fixture.requestHeaders['X-Poc157-Token']), false);
  assert.equal(fixture.unsupported, null);

  const missingPath = await postJson(fixture.baseUrl + '/v1/chat/completions', { input: 'PRIVATE_PATH_BODY' });
  assert.equal(missingPath.status, 404);
  assert.equal(fixture.requests.length, 3);
  assert.equal(JSON.stringify(fixture.requests).includes('PRIVATE_PATH_BODY'), false);
});

test('fixture uses the observed namespace and multi-tool recipient names', async (t) => {
  const fixture = createFixtureServer({ mcpProbeToolName: mcpName });
  await fixture.start();
  t.after(() => fixture.close());

  const wrapper = {
    type: 'function',
    name: 'multi_tool_use.parallel',
    parameters: {
      type: 'object',
      properties: {
        tool_uses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              recipient_name: { type: 'string', enum: ['functions.exec_command', mcpName] },
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' }, session_id: { type: ['string', 'null'] } },
              },
            },
            required: ['recipient_name', 'parameters'],
          },
        },
      },
      required: ['tool_uses'],
    },
  };
  const body = { model: 'fixture-model', tools: [wrapper] };

  const first = readEvents((await postJson(fixture.baseUrl + '/responses', body, fixture.requestHeaders)).body);
  assert.equal(first[1].item.name, 'multi_tool_use.parallel');
  assert.deepEqual(JSON.parse(first[2].arguments), {
    tool_uses: [{ recipient_name: 'functions.exec_command', parameters: { cmd: 'Write-Output POC157; exit 7' } }],
  });

  const second = readEvents((await postJson(fixture.baseUrl + '/responses', body, fixture.requestHeaders)).body);
  assert.equal(second[1].item.name, 'multi_tool_use.parallel');
  assert.deepEqual(JSON.parse(second[2].arguments), {
    tool_uses: [{ recipient_name: mcpName, parameters: {} }],
  });
  assert.equal(fixture.unsupported, null);
});

test('fixture reports an absent MCP declaration and never guesses its call name', async (t) => {
  const fixture = createFixtureServer({ mcpProbeToolName: mcpName });
  await fixture.start();
  t.after(() => fixture.close());

  const commandOnly = { model: 'fixture-model', tools: [directTools()[0]] };
  await postJson(fixture.baseUrl + '/responses', commandOnly, fixture.requestHeaders);
  const second = readEvents((await postJson(fixture.baseUrl + '/responses', commandOnly, fixture.requestHeaders)).body);

  assert.equal(fixture.unsupported, '設定されたMCP probeツール ' + mcpName + ' はResponsesリクエストに宣言されていません。');
  assert.match(second.at(-1).response.output[0].content[0].text, /poc157_identity\.probe_identity/);
  assert.equal(second.some((event) => event.type === 'response.function_call_arguments.done'), false);
});

test('fixture rejects missing tokens, mismatched Host, and every Origin without advancing', async (t) => {
  const fixture = createFixtureServer({ mcpProbeToolName: mcpName });
  await fixture.start();
  t.after(() => fixture.close());
  const body = { model: 'fixture-model', tools: directTools() };

  assert.equal((await postJson(fixture.baseUrl + '/responses', body)).status, 403);
  assert.equal((await postJson(fixture.baseUrl + '/responses', body, {
    ...fixture.requestHeaders,
    Origin: 'null',
  })).status, 403);
  assert.equal((await postJson(fixture.baseUrl + '/responses', body, {
    ...fixture.requestHeaders,
    Host: 'localhost:1',
  })).status, 403);
  assert.equal(fixture.requests.length, 0);

  const accepted = await postJson(fixture.baseUrl + '/responses', body, fixture.requestHeaders);
  assert.equal(accepted.status, 200);
  assert.equal(readEvents(accepted.body)[1].item.name, 'exec_command');
  assert.equal(fixture.requests.length, 1);
});

test('fixture can start with the namespaced MCP probe and preserves call identifiers', async (t) => {
  const fixture = createFixtureServer({ startWith: 'mcp', mcpProbeToolName: mcpName });
  await fixture.start();
  t.after(() => fixture.close());

  const first = await postJson(fixture.baseUrl + '/responses', {
    model: 'fixture-model',
    tools: [directTools()[1]],
  }, fixture.requestHeaders);
  const events = readEvents(first.body);
  assert.deepEqual(events.map((event) => event.type), [
    'response.created',
    'response.output_item.added',
    'response.function_call_arguments.done',
    'response.output_item.done',
    'response.completed',
  ]);
  assert.deepEqual(events.map((event) => event.sequence_number), [0, 1, 2, 3, 4]);

  const added = events[1].item;
  const completedItem = events[3].item;
  const finalItem = events[4].response.output[0];
  assert.equal(events[0].response.id, events[4].response.id);
  assert.equal(added.id, events[2].item_id);
  assert.equal(added.id, completedItem.id);
  assert.equal(added.id, finalItem.id);
  assert.equal(added.call_id, completedItem.call_id);
  assert.equal(added.call_id, finalItem.call_id);
  assert.equal(added.name, 'probe_identity');
  assert.equal(added.namespace, 'mcp__poc157_identity');
  assert.equal(completedItem.namespace, added.namespace);
  assert.equal(finalItem.namespace, added.namespace);
  assert.equal(added.arguments, '');
  assert.equal(completedItem.arguments, events[2].arguments);
  assert.deepEqual(JSON.parse(events[2].arguments), { session_id: null });

  assert.throws(() => createFixtureServer({ startWith: 'final' }), /startWith/);
});

test('fixture omits credential-like identity header values from summaries', async (t) => {
  const fixture = createFixtureServer({ mcpProbeToolName: mcpName });
  await fixture.start();
  t.after(() => fixture.close());

  const bearerValue = 'Bearer PRIVATE_BEARER_VALUE';
  const apiKeyValue = 'sk-proj-PRIVATE_API_KEY';
  await postJson(fixture.baseUrl + '/responses', {
    model: 'fixture-model',
    tools: directTools(),
  }, {
    ...fixture.requestHeaders,
    'X-Codex-Thread-Id': bearerValue,
    'X-Codex-Session-Id': apiKeyValue,
  });

  const summary = fixture.requests[0];
  assert.ok(summary.headerNames.includes('x-codex-thread-id'));
  assert.ok(summary.headerNames.includes('x-codex-session-id'));
  assert.equal(Object.hasOwn(summary.identityHeaders, 'x-codex-thread-id'), false);
  assert.equal(Object.hasOwn(summary.identityHeaders, 'x-codex-session-id'), false);
  const retained = JSON.stringify(fixture.requests);
  assert.equal(retained.includes(bearerValue), false);
  assert.equal(retained.includes(apiKeyValue), false);
  assert.equal(retained.includes(fixture.requestHeaders['X-Poc157-Token']), false);
});
