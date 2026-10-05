'use strict';

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const RESPONSE_PATHS = new Set(['/responses', '/v1/responses']);
const IDENTITY_HEADERS = new Set([
  'x-codex-session-id', 'x-codex-thread-id', 'x-session-id', 'x-thread-id',
  'session-id', 'thread-id', 'openai-session-id', 'x-openai-session-id',
]);
const CREDENTIAL_PREFIX = /^\s*(?:bearer\s+|basic\s+|token\s+|sk-\S+|gh[pousr]_\S+|github_pat_\S+|xox[baprs]-\S+|ya29\.\S+|eyj[a-z0-9_-]+\.[a-z0-9_-]+|(?:api[_-]?key|access[_-]?token|secret)\s*[:=])/i;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_COMMAND = 'Write-Output POC157; exit 7';
const DEFAULT_FINAL_TEXT = 'ローカルfixtureの固定シナリオが完了しました。実モデルや実APIの観測結果ではありません。';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inputSchema(tool) {
  if (!isRecord(tool)) return null;
  return tool.parameters || tool.input_schema || tool.inputSchema || tool.schema || null;
}

function collectSchemaKeys(schema) {
  const keys = new Set();
  const visited = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (isRecord(value.properties)) {
      for (const [key, child] of Object.entries(value.properties)) {
        keys.add(key);
        visit(child);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'properties') visit(child);
    }
  };
  visit(schema);
  return [...keys].sort().slice(0, 256);
}

function discoverTools(tools) {
  const callables = [];
  const inventory = [];
  const visited = new Set();
  const addInventory = (name, schema) => {
    if (typeof name !== 'string' || !name) return;
    const keys = collectSchemaKeys(schema);
    if (!inventory.some((entry) => entry.name === name && entry.schemaKeys.join('\0') === keys.join('\0'))) {
      inventory.push({ name, schemaKeys: keys });
    }
  };
  const addCallable = (tool, namespace) => {
    const localName = tool.name;
    if (typeof localName !== 'string' || !localName) return;
    const toolNamespace = typeof tool.namespace === 'string' ? tool.namespace : namespace;
    const publicName = toolNamespace && !localName.startsWith(toolNamespace + '.')
      ? toolNamespace + '.' + localName
      : localName;
    const schema = inputSchema(tool);
    const descriptor = { name: publicName, localName, namespace: toolNamespace || null, schema };
    callables.push(descriptor);
    addInventory(publicName, schema);
  };
  const visit = (value, namespace = null) => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, namespace));
      return;
    }
    if (!isRecord(value) || visited.has(value)) return;
    visited.add(value);

    if (value.type === 'mcp') {
      if (typeof value.server_label === 'string') addInventory(value.server_label, null);
      if (Array.isArray(value.allowed_tools)) {
        for (const item of value.allowed_tools) {
          const name = typeof item === 'string' ? item : item && item.name;
          if (typeof name === 'string') addInventory(name, item && item.input_schema);
        }
      }
      return;
    }

    const children = [];
    for (const key of ['tools', 'functions']) {
      if (Array.isArray(value[key])) children.push(...value[key]);
    }
    const nestedNamespace = value.type === 'namespace' && typeof value.name === 'string'
      ? (namespace ? namespace + '.' + value.name : value.name)
      : namespace;
    if (value.type === 'namespace' && typeof value.name === 'string') addInventory(nestedNamespace, null);

    const functionTool = isRecord(value.function) ? value.function : value;
    const schema = inputSchema(functionTool) || inputSchema(value);
    if (typeof functionTool.name === 'string' && (schema || value.type === 'function')) {
      addCallable({ ...functionTool, parameters: schema }, nestedNamespace);
    }
    for (const child of children) visit(child, nestedNamespace);
  };
  visit(tools);

  for (const callable of callables) {
    const wrapper = findMultiToolShape(callable.schema);
    if (wrapper) {
      for (const name of wrapper.names) addInventory(name, null);
      callable.multiTool = wrapper;
    }
  }
  return { callables, inventory };
}

function findMultiToolShape(schema) {
  const properties = schema && schema.properties;
  if (!isRecord(properties)) return null;
  for (const [arrayName, arraySchema] of Object.entries(properties)) {
    if (arraySchema?.type !== 'array' || !isRecord(arraySchema.items)) continue;
    const itemProperties = arraySchema.items.properties;
    if (!isRecord(itemProperties)) continue;
    const recipientName = Object.keys(itemProperties).find((key) => /recipient.*name|tool.*name/i.test(key));
    if (!recipientName) continue;
    const argumentNames = Object.keys(itemProperties).filter((key) => key !== recipientName && isRecord(itemProperties[key]));
    if (argumentNames.length !== 1) continue;
    const recipientSchema = itemProperties[recipientName];
    const names = Array.isArray(recipientSchema.enum) ? recipientSchema.enum.filter((name) => typeof name === 'string') : [];
    return {
      arrayName,
      recipientName,
      argumentsName: argumentNames[0],
      argumentsSchema: itemProperties[argumentNames[0]],
      names,
      required: Array.isArray(schema.required) ? schema.required : [],
      itemRequired: Array.isArray(arraySchema.items.required) ? arraySchema.items.required : [],
    };
  }
  return null;
}

function commandMatches(descriptor, exactName) {
  if (exactName) return descriptor.name === exactName;
  return descriptor.localName === 'exec_command' || descriptor.name.split(/[./:]/).pop() === 'exec_command';
}

function findCallPlan(discovery, kind, scenario) {
  const isCommand = kind === 'command';
  const configuredName = isCommand ? scenario.execCommandToolName : scenario.mcpProbeToolName;
  if (!isCommand && (typeof configuredName !== 'string' || !configuredName)) {
    return { error: 'MCP probeツールの完全一致名が設定されていません。' };
  }

  const direct = discovery.callables.filter((descriptor) => (
    isCommand ? commandMatches(descriptor, configuredName) : descriptor.name === configuredName
  ));
  if (direct.length > 1) return { error: '宣言されたツール名が重複しており、呼び先を特定できません。' };
  if (direct.length === 1) {
    const descriptor = direct[0];
    const args = isCommand
      ? buildCommandArguments(descriptor.schema, scenario)
      : buildMcpArguments(descriptor.schema, scenario.mcpArguments);
    if (args.error) return { error: args.error };
    return { name: descriptor.localName, namespace: descriptor.namespace, arguments: args.value };
  }

  const wrapped = [];
  for (const descriptor of discovery.callables) {
    if (!descriptor.multiTool) continue;
    const shape = descriptor.multiTool;
    const candidates = isCommand
      ? shape.names.filter((name) => name.split(/[./:]/).pop() === 'exec_command')
      : shape.names.filter((name) => name === configuredName);
    for (const recipient of candidates) {
      const innerSchema = shape.argumentsSchema;
      const innerArgs = isCommand
        ? buildCommandArguments(innerSchema, scenario)
        : buildMcpArguments(innerSchema, scenario.mcpArguments);
      if (innerArgs.error) return { error: innerArgs.error };
      if (shape.required.some((key) => key !== shape.arrayName) || shape.itemRequired.some((key) => key !== shape.recipientName && key !== shape.argumentsName)) {
        return { error: 'multi-tool wrapperの必須引数を宣言schemaから補えません。' };
      }
      wrapped.push({
        name: descriptor.localName,
        namespace: descriptor.namespace,
        arguments: { [shape.arrayName]: [{
          [shape.recipientName]: recipient,
          [shape.argumentsName]: innerArgs.value,
        }] },
      });
    }
  }
  if (wrapped.length > 1) return { error: 'multi-tool wrapperの呼び先が複数あり、特定できません。' };
  if (wrapped.length === 1) return wrapped[0];
  return { error: isCommand
    ? 'Responsesリクエストに利用可能なexec_commandのschemaがありません。'
    : '設定されたMCP probeツール ' + configuredName + ' はResponsesリクエストに宣言されていません。' };
}

function buildCommandArguments(schema, scenario) {
  if (scenario.commandArguments !== undefined) return validateArguments(schema, scenario.commandArguments);
  if (!isRecord(schema) || !isRecord(schema.properties) || !schema.properties.cmd) {
    return { error: 'exec_commandのschemaにcmdプロパティがありません。' };
  }
  const command = typeof scenario.command === 'string' ? scenario.command : DEFAULT_COMMAND;
  const cmdSchema = schema.properties.cmd;
  let cmd;
  if (cmdSchema.type === 'array') {
    cmd = ['powershell.exe', '-NoProfile', '-Command', command];
  } else if (!cmdSchema.type || cmdSchema.type === 'string') {
    cmd = command;
  } else {
    return { error: 'exec_commandのcmdプロパティ型には対応していません。' };
  }
  const args = { cmd };
  for (const name of Array.isArray(schema.required) ? schema.required : []) {
    if (Object.hasOwn(args, name)) continue;
    if (name === 'workdir' && schema.properties.workdir) args.workdir = scenario.workdir || process.cwd();
    else if (name === 'yield_time_ms' && schema.properties[name]) args[name] = 10000;
    else if (name === 'max_output_tokens' && schema.properties[name]) args[name] = 1000;
    else return { error: 'exec_commandの必須schemaプロパティをfixtureから補えません: ' + name };
  }
  return validateArguments(schema, args);
}

function allowsNull(schema) {
  if (!isRecord(schema)) return false;
  if (schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null')) || schema.nullable === true) return true;
  return ['anyOf', 'oneOf'].some((key) => Array.isArray(schema[key]) && schema[key].some(allowsNull));
}

function buildMcpArguments(schema, supplied) {
  if (supplied !== undefined) return validateArguments(schema, supplied);
  if (!isRecord(schema)) return { error: 'The MCP probe schema was not declared as a function schema.' };
  const args = {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const name of Array.isArray(schema.required) ? schema.required : []) {
    if (/session|thread/i.test(name) && allowsNull(properties[name])) args[name] = null;
    else return { error: 'MCP probeの必須引数をfixtureから推測できません: ' + name };
  }
  return validateArguments(schema, args);
}

function validateArguments(schema, args) {
  if (!isRecord(args)) return { error: 'ツール引数はJSON objectである必要があります。' };
  if (isRecord(schema)) {
    const properties = isRecord(schema.properties) ? schema.properties : null;
    if (schema.additionalProperties === false && properties) {
      const unexpected = Object.keys(args).find((key) => !Object.hasOwn(properties, key));
      if (unexpected) return { error: '設定したツール引数が宣言schemaに一致しません。' };
    }
    const missing = (Array.isArray(schema.required) ? schema.required : []).find((key) => !Object.hasOwn(args, key));
    if (missing) return { error: '設定したツール引数に必須schemaプロパティがありません: ' + missing };
  }
  return { value: args };
}

function headerSummary(headers) {
  const names = Object.keys(headers).sort();
  const identities = {};
  for (const name of names) {
    if (!IDENTITY_HEADERS.has(name)) continue;
    const value = headers[name];
    if (typeof value === 'string' && value.length <= 256 && !CREDENTIAL_PREFIX.test(value)) identities[name] = value;
  }
  return { names, identities };
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function fieldTypes(value) {
  if (!isRecord(value)) return [];
  return Object.keys(value).sort().map((key) => ({ key, type: valueType(value[key]) }));
}

function bodyShape(body) {
  const topLevel = fieldTypes(body);
  const toolsValue = isRecord(body) ? body.tools : undefined;
  let tools;
  if (Array.isArray(toolsValue)) {
    tools = {
      type: 'array',
      items: toolsValue.slice(0, 4).map((item) => ({
        type: valueType(item),
        keys: isRecord(item) ? Object.keys(item).sort() : [],
        fields: fieldTypes(item),
      })),
    };
  } else if (isRecord(toolsValue)) {
    tools = { type: 'object', keys: Object.keys(toolsValue).sort(), fields: fieldTypes(toolsValue) };
  } else {
    tools = { type: valueType(toolsValue), keys: [], fields: [] };
  }
  return { topLevel, tools };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(chunk);
    }
  }
  if (tooLarge) {
    const error = new Error('リクエストが大きすぎます');
    error.statusCode = 413;
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('JSONを解析できません');
    error.statusCode = 400;
    throw error;
  }
}

function sseResponse(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const event of events) {
    res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
  }
  res.end();
}

function makeResponseId(number) {
  return 'resp_fixture_' + String(number).padStart(3, '0');
}

function responseBase(id, model, createdAt, status, output) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    completed_at: status === 'completed' ? createdAt : null,
    error: null,
    incomplete_details: null,
    model,
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    store: false,
    usage: null,
  };
}

function toolCallEvents(responseNumber, model, call, args) {
  const id = makeResponseId(responseNumber);
  const itemId = 'fc_fixture_' + String(responseNumber).padStart(3, '0');
  const callId = 'call_fixture_' + String(responseNumber).padStart(3, '0');
  const createdAt = Math.floor(Date.now() / 1000);
  const argumentText = JSON.stringify(args);
  const item = {
    id: itemId,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name: call.name,
    ...(call.namespace ? { namespace: call.namespace } : {}),
    arguments: argumentText,
  };
  let sequence = 0;
  const event = (type, values) => ({ type, ...values, sequence_number: sequence++ });
  return [
    event('response.created', { response: responseBase(id, model, createdAt, 'in_progress', []) }),
    event('response.output_item.added', {
      output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' },
    }),
    event('response.function_call_arguments.done', { item_id: itemId, output_index: 0, arguments: argumentText }),
    event('response.output_item.done', { output_index: 0, item }),
    event('response.completed', { response: responseBase(id, model, createdAt, 'completed', [item]) }),
  ];
}

function textEvents(responseNumber, model, text) {
  const id = makeResponseId(responseNumber);
  const itemId = 'msg_fixture_' + String(responseNumber).padStart(3, '0');
  const createdAt = Math.floor(Date.now() / 1000);
  let sequence = 0;
  const event = (type, values) => ({ type, ...values, sequence_number: sequence++ });
  const part = { type: 'output_text', text, annotations: [] };
  const item = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [part] };
  return [
    event('response.created', { response: responseBase(id, model, createdAt, 'in_progress', []) }),
    event('response.output_item.added', {
      output_index: 0,
      item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    }),
    event('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
    event('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: text }),
    event('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text }),
    event('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part }),
    event('response.output_item.done', { output_index: 0, item }),
    event('response.completed', { response: responseBase(id, model, createdAt, 'completed', [item]) }),
  ];
}

function setCommonResponseHeaders(response) {
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function createFixtureServer(scenario = {}) {
  if (!isRecord(scenario)) throw new TypeError('scenarioはobjectである必要があります');
  const startWith = scenario.startWith ?? 'command';
  if (!['command', 'mcp'].includes(startWith)) throw new TypeError('startWithはcommandまたはmcpである必要があります');
  const requests = [];
  const secret = randomBytes(32).toString('hex');
  let stage = startWith;
  let responseNumber = 0;
  let unsupported = null;

  const server = http.createServer(async (req, res) => {
    setCommonResponseHeaders(res);
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (req.method !== 'POST' || !RESPONSE_PATHS.has(url.pathname)) {
      req.resume();
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('見つかりません');
      return;
    }

    const address = server.address();
    const expectedHost = address && typeof address === 'object' ? '127.0.0.1:' + address.port : '';
    const suppliedToken = req.headers['x-poc157-token'];
    const validToken = typeof suppliedToken === 'string' && Buffer.byteLength(suppliedToken) === Buffer.byteLength(secret) &&
      timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(secret));
    if (req.headers.host !== expectedHost || Object.hasOwn(req.headers, 'origin') || !validToken) {
      req.resume();
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('拒否されました');
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      res.writeHead(error.statusCode || 400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('fixtureリクエストが不正です');
      return;
    }

    const discovery = discoverTools(body && body.tools);
    const headers = headerSummary(req.headers);
    requests.push({
      path: url.pathname,
      toolNames: discovery.inventory.map((entry) => entry.name),
      tools: discovery.inventory,
      bodyShape: bodyShape(body),
      headerNames: headers.names,
      identityHeaders: headers.identities,
    });

    const model = typeof scenario.model === 'string'
      ? scenario.model
      : typeof body?.model === 'string' ? body.model : 'gpt-6.1-sol';
    responseNumber += 1;
    if (stage === 'command' || stage === 'mcp') {
      const kind = stage;
      const plan = findCallPlan(discovery, kind, scenario);
      if (plan.error) {
        unsupported = plan.error;
        stage = 'done';
        const names = discovery.inventory.map((entry) => entry.name);
        const detail = names.length ? ' 宣言された公開ツール名: ' + [...new Set(names)].join(', ') + '。' : ' 公開ツール名は宣言されていません。';
        sseResponse(res, textEvents(responseNumber, model,
          'ローカルResponses fixtureでは未対応です: ' + plan.error + detail + ' この手順のツール呼び出しは行っていません。'));
        return;
      }
      stage = kind === 'command' ? 'mcp' : 'final';
      sseResponse(res, toolCallEvents(responseNumber, model, plan, plan.arguments));
      return;
    }

    stage = 'done';
    const text = typeof scenario.finalText === 'string' ? scenario.finalText : DEFAULT_FINAL_TEXT;
    sseResponse(res, textEvents(responseNumber, model, text));
  });

  const fixture = {
    server,
    requests,
    get requestHeaders() {
      return { 'X-Poc157-Token': secret };
    },
    get baseUrl() {
      const address = server.address();
      return address && typeof address === 'object' ? 'http://127.0.0.1:' + address.port : null;
    },
    get unsupported() {
      return unsupported;
    },
    async start() {
      if (!server.listening) {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.off('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(0, '127.0.0.1');
        });
      }
      return fixture;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
  return fixture;
}

module.exports = { createFixtureServer };
