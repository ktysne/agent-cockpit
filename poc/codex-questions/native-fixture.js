'use strict';

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const FIXTURE_MODEL = 'poc160-native-fixture-model';
const FINAL_TEXT = 'The local question fixture completed. This was not a real model result.';
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS = 8;
const MAX_TOOL_NAMES = 48;
const MAX_SCHEMA_KEYS = 160;
const TOOL_NAME = 'request_user_input';
const ANSWER_KINDS = Object.freeze(['choice', 'free-text']);
const FIXED_FREE_TEXT_ANSWER = 'fixture free text';
const QUESTION_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'poc160_choice',
    header: '選択',
    question: '隔離テストの選択肢を一つ選んでください。',
    options: Object.freeze([
      Object.freeze({ label: '候補 A', description: '固定 fixture の選択肢です。' }),
      Object.freeze({ label: '候補 B', description: '固定 fixture の選択肢です。' }),
    ]),
    isOther: false,
    isSecret: false,
    answer: '候補 A',
  }),
  Object.freeze({
    id: 'poc160_free_text',
    header: '自由入力',
    question: '固定 fixture の短い文字列を入力してください。',
    options: Object.freeze([
      Object.freeze({ label: '候補 C', description: '固定 fixture の選択肢です。' }),
      Object.freeze({ label: '候補 D', description: '固定 fixture の選択肢です。' }),
    ]),
    isOther: true,
    isSecret: false,
    answer: 'fixture free text',
  }),
]);
const QUESTION_PROFILES = Object.freeze({
  single: Object.freeze([QUESTION_TEMPLATES[0]]),
  full: QUESTION_TEMPLATES,
});
const RESPONSE_PATHS = new Set(['/responses', '/v1/responses']);
const SAFE_NAME = /^[A-Za-z0-9_./:-]{1,128}$/;
const ANSWER_VALUES = new Set([
  ...QUESTION_TEMPLATES.flatMap((question) => question.options.map((option) => option.label)),
  FIXED_FREE_TEXT_ANSWER,
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeName(value) {
  return typeof value === 'string' && SAFE_NAME.test(value) ? value : null;
}

function schemaOf(value) {
  if (!isRecord(value)) return null;
  return value.parameters || value.input_schema || value.inputSchema || value.schema || null;
}

function schemaKeys(schema) {
  const result = new Set();
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (isRecord(value.properties)) {
      for (const [key, child] of Object.entries(value.properties)) {
        if (safeName(key)) result.add(key);
        visit(child);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'properties') visit(child);
    }
  };
  visit(schema);
  return [...result].sort().slice(0, MAX_SCHEMA_KEYS);
}

function discoverFunctions(value) {
  const functions = [];
  const seen = new Set();
  const visit = (item, inheritedNamespace = null) => {
    if (Array.isArray(item)) {
      item.forEach((child) => visit(child, inheritedNamespace));
      return;
    }
    if (!isRecord(item) || seen.has(item)) return;
    seen.add(item);
    const namespace = item.type === 'namespace' && typeof item.name === 'string'
      ? inheritedNamespace ? inheritedNamespace + '.' + item.name : item.name
      : inheritedNamespace;
    const functionValue = isRecord(item.function) ? item.function : item;
    const localName = safeName(functionValue.name);
    const schema = schemaOf(functionValue) || schemaOf(item);
    if (localName && schema) {
      const explicitNamespace = safeName(functionValue.namespace || item.namespace);
      functions.push({
        localName,
        namespace: explicitNamespace || namespace,
        schema,
      });
    }
    for (const key of ['tools', 'functions']) visit(item[key], namespace);
  };
  visit(value);
  return functions;
}

function questionArgument(question, schema) {
  const properties = isRecord(schema?.properties) ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  if (Object.hasOwn(properties, 'multiSelect') || required.includes('multiSelect')) {
    return { error: 'multi_select_schema_unsupported' };
  }
  const allowed = new Set(Object.keys(properties));
  const result = {};
  for (const key of ['id', 'header', 'question']) {
    if (!allowed.has(key)) return { error: 'question_schema_unsupported' };
    result[key] = question[key];
  }
  for (const key of ['options', 'isOther', 'isSecret']) {
    if (allowed.has(key)) result[key] = question[key];
  }
  if (!allowed.has('options') || !isRecord(properties.options)) return { error: 'question_options_unsupported' };
  if (Number.isInteger(properties.options.minItems) && properties.options.minItems > question.options.length) {
    return { error: 'question_options_minimum_unsupported' };
  }
  if (Number.isInteger(properties.options.maxItems) && properties.options.maxItems < question.options.length) {
    return { error: 'question_options_maximum_unsupported' };
  }
  if (question.isOther && !allowed.has('isOther')) return { error: 'free_form_schema_unsupported' };
  if (allowed.has('isOther') && properties.isOther.type && properties.isOther.type !== 'boolean') {
    return { error: 'free_form_schema_unsupported' };
  }
  if (allowed.has('isSecret') && properties.isSecret.type && properties.isSecret.type !== 'boolean') {
    return { error: 'secret_field_schema_unsupported' };
  }
  if (required.some((key) => !Object.hasOwn(result, key))) return { error: 'question_schema_unsupported' };
  return { value: result };
}

function buildQuestionArguments(schema, options = {}) {
  if (!isRecord(schema) || !isRecord(schema.properties)) return { error: 'tool_schema_missing' };
  const properties = schema.properties;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!Object.hasOwn(properties, 'questions')) {
    return { error: 'request_user_input_schema_unsupported' };
  }
  if (properties.multiSelect || required.includes('multiSelect')) return { error: 'multi_select_schema_unsupported' };
  if (required.includes('isBlocking') && !Object.hasOwn(properties, 'isBlocking')) {
    return { error: 'blocking_schema_unsupported' };
  }
  if (properties.isBlocking && properties.isBlocking.type && properties.isBlocking.type !== 'boolean') {
    return { error: 'blocking_schema_unsupported' };
  }
  const blocking = typeof options.blocking === 'boolean' ? options.blocking : true;
  if (!blocking && !Object.hasOwn(properties, 'isBlocking')) return { error: 'blocking_not_configurable' };
  const templates = Array.isArray(options.templates) ? options.templates : QUESTION_TEMPLATES;
  const questionsSchema = properties.questions.items || {};
  if (Number.isInteger(properties.questions.minItems) && properties.questions.minItems > templates.length) {
    return { error: 'question_count_minimum_unsupported' };
  }
  if (Number.isInteger(properties.questions.maxItems) && properties.questions.maxItems < templates.length) {
    return { error: 'question_count_maximum_unsupported' };
  }
  const questions = [];
  for (const question of templates) {
    const projected = questionArgument(question, questionsSchema);
    if (projected.error) return projected;
    questions.push(projected.value);
  }
  const args = { questions };
  if (Object.hasOwn(properties, 'isBlocking')) args.isBlocking = blocking;
  if (required.some((key) => !Object.hasOwn(args, key))) return { error: 'tool_required_argument_unsupported' };
  if (schema.additionalProperties === false && Object.keys(args).some((key) => !Object.hasOwn(properties, key))) {
    return { error: 'tool_argument_schema_mismatch' };
  }
  return { value: args, questionIds: templates.map((question) => question.id) };
}

function questionSchemaSummary(schema) {
  const properties = isRecord(schema?.properties) ? schema.properties : {};
  const questionsSchema = properties.questions;
  const questionItemSchema = isRecord(questionsSchema?.items) ? questionsSchema.items : {};
  const questionProperties = isRecord(questionItemSchema.properties) ? questionItemSchema.properties : {};
  const optionsSchema = isRecord(questionProperties.options) ? questionProperties.options : {};
  const optionItemSchema = isRecord(optionsSchema.items) ? optionsSchema.items : {};
  const safeKeys = (value) => Array.isArray(value) ? value.filter((key) => safeName(key)).sort().slice(0, 32) : [];
  return {
    top_level_keys: safeKeys(Object.keys(properties)),
    top_level_required: safeKeys(schema.required),
    question_min_items: Number.isInteger(questionsSchema?.minItems) ? questionsSchema.minItems : null,
    question_max_items: Number.isInteger(questionsSchema?.maxItems) ? questionsSchema.maxItems : null,
    question_item_keys: safeKeys(Object.keys(questionProperties)),
    question_item_required: safeKeys(questionItemSchema.required),
    options_min_items: Number.isInteger(optionsSchema.minItems) ? optionsSchema.minItems : null,
    options_max_items: Number.isInteger(optionsSchema.maxItems) ? optionsSchema.maxItems : null,
    option_item_keys: safeKeys(Object.keys(optionItemSchema.properties || {})),
    option_item_required: safeKeys(optionItemSchema.required),
    is_blocking_declared: Object.hasOwn(properties, 'isBlocking'),
    is_other_declared: Object.hasOwn(questionProperties, 'isOther'),
    is_secret_declared: Object.hasOwn(questionProperties, 'isSecret'),
  };
}

function multiToolShape(schema) {
  const properties = schema?.properties;
  if (!isRecord(properties)) return null;
  for (const [arrayName, arraySchema] of Object.entries(properties)) {
    if (arraySchema?.type !== 'array' || !isRecord(arraySchema.items) || !isRecord(arraySchema.items.properties)) continue;
    const itemProperties = arraySchema.items.properties;
    const recipientName = Object.keys(itemProperties).find((key) => /recipient.*name|tool.*name/i.test(key));
    if (!recipientName) continue;
    const argumentNames = Object.keys(itemProperties).filter((key) => key !== recipientName && isRecord(itemProperties[key]));
    if (argumentNames.length !== 1) continue;
    const names = Array.isArray(itemProperties[recipientName].enum)
      ? itemProperties[recipientName].enum.filter((name) => typeof name === 'string')
      : [];
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

function findQuestionCallPlan(tools, options = {}) {
  const functions = discoverFunctions(tools);
  const questionProfile = options.questionProfile || 'full';
  const templates = QUESTION_PROFILES[questionProfile];
  if (!templates) return { error: 'question_profile_unsupported' };
  const direct = functions.filter((item) => item.localName === TOOL_NAME);
  if (direct.length > 1) return { error: 'tool_declaration_ambiguous' };
  if (direct.length === 1) {
    const descriptor = direct[0];
    const args = buildQuestionArguments(descriptor.schema, { ...options, templates });
    if (args.error) return args;
    return {
      value: {
        name: descriptor.localName,
        namespace: descriptor.namespace,
          targetTool: TOOL_NAME,
          targetNamespace: descriptor.namespace,
          arguments: args.value,
          questionIds: args.questionIds,
          schemaSummary: questionSchemaSummary(descriptor.schema),
        },
    };
  }
  const wrappers = [];
  for (const descriptor of functions) {
    const shape = multiToolShape(descriptor.schema);
    if (!shape || !shape.names.includes(TOOL_NAME)) continue;
    const args = buildQuestionArguments(shape.argumentsSchema, { ...options, templates });
    if (args.error) return args;
    if (shape.required.some((key) => key !== shape.arrayName)
      || shape.itemRequired.some((key) => key !== shape.recipientName && key !== shape.argumentsName)) {
      return { error: 'multi_tool_required_argument_unsupported' };
    }
    wrappers.push({
      name: descriptor.localName,
      namespace: descriptor.namespace,
      targetTool: TOOL_NAME,
      targetNamespace: descriptor.namespace,
      questionIds: args.questionIds,
      schemaSummary: questionSchemaSummary(shape.argumentsSchema),
      arguments: {
        [shape.arrayName]: [{
          [shape.recipientName]: TOOL_NAME,
          [shape.argumentsName]: args.value,
        }],
      },
    });
  }
  if (wrappers.length > 1) return { error: 'tool_declaration_ambiguous' };
  if (wrappers.length === 1) return { value: wrappers[0] };
  return { error: 'request_user_input_unavailable' };
}

function fieldTypes(value) {
  if (!isRecord(value)) return [];
  return Object.keys(value).sort().slice(0, 96).map((key) => ({
    key: safeName(key) || 'unknown',
    type: value[key] === null ? 'null' : Array.isArray(value[key]) ? 'array' : typeof value[key],
  }));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('request_too_large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid_json'), { statusCode: 400 });
  }
}

function makeResponseId(index) {
  return `poc160_response_${String(index).padStart(3, '0')}`;
}

function makeFunctionCallEvents(number, call) {
  const responseId = makeResponseId(number);
  const itemId = `poc160_item_${String(number).padStart(3, '0')}`;
  const callId = `poc160_call_${String(number).padStart(3, '0')}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const argumentText = JSON.stringify(call.arguments);
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
  const inProgressItem = { ...item, status: 'in_progress', arguments: '' };
  const inProgress = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'in_progress',
    model: FIXTURE_MODEL,
    output: [],
    parallel_tool_calls: false,
    previous_response_id: null,
    store: false,
  };
  const completed = { ...inProgress, status: 'completed', completed_at: createdAt, output: [item] };
  return {
    itemId,
    callId,
    events: [
      event('response.created', { response: inProgress }),
      event('response.output_item.added', { output_index: 0, item: inProgressItem }),
      event('response.function_call_arguments.done', { item_id: itemId, output_index: 0, arguments: argumentText }),
      event('response.output_item.done', { output_index: 0, item }),
      event('response.completed', { response: completed }),
    ],
  };
}

function makeFinalEvents(number) {
  const responseId = makeResponseId(number);
  const itemId = `poc160_final_${String(number).padStart(3, '0')}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const item = {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: FINAL_TEXT, annotations: [] }],
  };
  let sequence = 0;
  const event = (type, values) => ({ type, ...values, sequence_number: sequence++ });
  const inProgress = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'in_progress',
    model: FIXTURE_MODEL,
    output: [],
    parallel_tool_calls: false,
    previous_response_id: null,
    store: false,
  };
  const completed = { ...inProgress, status: 'completed', completed_at: createdAt, output: [item] };
  return [
    event('response.created', { response: inProgress }),
    event('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } }),
    event('response.output_item.done', { output_index: 0, item }),
    event('response.completed', { response: completed }),
  ];
}

function writeEvents(response, events) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

function answerForQuestion(question, answerKind) {
  return answerKind === 'free-text' ? FIXED_FREE_TEXT_ANSWER : question.options[0].label;
}

function inspectFixedAnswerOutput(body, callId, questionIds = QUESTION_TEMPLATES.map((question) => question.id), answerKind = 'choice') {
  let foundCallOutput = false;
  let outputValue;
  const seen = new Set();
  let visited = 0;
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 10 || visited >= 4096) return;
    seen.add(value);
    visited += 1;
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (value.type === 'function_call_output' && value.call_id === callId) {
      foundCallOutput = true;
      outputValue = value.output;
      return;
    }
    Object.values(value).forEach((child) => visit(child, depth + 1));
  };
  visit(body && body.input);
  let parsedOutput = outputValue;
  if (typeof parsedOutput === 'string') {
    try { parsedOutput = JSON.parse(parsedOutput); } catch { parsedOutput = null; }
  }
  const answerMap = isRecord(parsedOutput) && isRecord(parsedOutput.answers) ? parsedOutput.answers : null;
  const expectedQuestions = QUESTION_TEMPLATES.filter((question) => questionIds.includes(question.id));
  const answersStructurallyMatch = Boolean(answerMap)
    && expectedQuestions.length === questionIds.length
    && expectedQuestions.every((question) => {
      const answer = answerMap[question.id];
      return isRecord(answer) && Object.keys(answer).length === 1 && Array.isArray(answer.answers) && answer.answers.length === 1
        && answer.answers[0] === answerForQuestion(question, answerKind);
    })
    && Object.keys(parsedOutput).length === 1
    && Object.keys(answerMap).length === expectedQuestions.length;
  const fixedAnswerStringsPresent = typeof outputValue === 'string'
    && expectedQuestions.every((question) => outputValue.includes(answerForQuestion(question, answerKind)));
  const candidateText = typeof outputValue === 'string'
    ? outputValue
    : isRecord(outputValue) && typeof outputValue.error === 'string' ? outputValue.error
      : isRecord(outputValue) && typeof outputValue.message === 'string' ? outputValue.message
        : Array.isArray(outputValue) ? outputValue.filter((item) => item && item.type === 'input_text' && typeof item.text === 'string')
          .map((item) => item.text).join(' ').slice(0, 4096)
          : '';
  const normalizedText = candidateText.toLowerCase().slice(0, 4096);
  const mentionsQuestionTool = /\brequest_user_input\b/.test(normalizedText);
  const mentionsUnavailable = /\b(unavailable|not available|not supported|unsupported)\b/.test(normalizedText);
  const toolOutputErrorKind = mentionsQuestionTool && mentionsUnavailable && /\b(default|mode)\b/.test(normalizedText)
    ? 'default_mode_unavailable'
    : mentionsQuestionTool && /\bunknown\s+(tool|function)\b/.test(normalizedText)
      ? 'question_tool_unrecognized'
      : mentionsQuestionTool && mentionsUnavailable ? 'question_tool_unavailable'
        : answerMap ? 'structured_output' : foundCallOutput && typeof outputValue === 'string' ? 'unclassified_text' : 'unknown';
  const projectedKeys = isRecord(parsedOutput)
    ? Object.keys(parsedOutput).map((key) => ['answers', 'error', 'message', 'result', 'content'].includes(key) ? key : 'other').slice(0, 16)
    : [];
  return {
    call_output_seen: foundCallOutput,
    fixed_answer_strings_present: foundCallOutput && fixedAnswerStringsPresent,
    answers_structurally_match: foundCallOutput && answersStructurallyMatch,
    answer_encoding: foundCallOutput && answerMap ? 'question_id_map' : foundCallOutput ? 'unknown' : 'not_seen',
    tool_output_error_kind: foundCallOutput ? toolOutputErrorKind : 'not_seen',
    tool_output_type: foundCallOutput && outputValue !== null ? Array.isArray(outputValue) ? 'array' : typeof outputValue : 'unknown',
    tool_output_keys: projectedKeys,
  };
}

function sanitizeTools(tools) {
  return discoverFunctions(tools).slice(0, MAX_TOOL_NAMES).map((tool) => ({
    name: tool.localName,
    namespace: tool.namespace,
    schema_keys: schemaKeys(tool.schema),
  }));
}

function createNativeQuestionFixture(options = {}) {
  if (!isRecord(options)) throw new TypeError('options_must_be_object');
  const questionProfile = options.questionProfile || 'full';
  if (!Object.hasOwn(QUESTION_PROFILES, questionProfile)) throw new TypeError('question_profile_unsupported');
  const answerKind = options.answerKind || 'choice';
  if (!ANSWER_KINDS.includes(answerKind)) throw new TypeError('answer_kind_unsupported');
  const secret = randomBytes(32).toString('hex');
  const requests = [];
  let responseNumber = 0;
  let callState = null;
  let unsupported = null;
  let answerOutput = {
    answer_kind: answerKind,
    call_output_seen: false,
    fixed_answer_strings_present: false,
    answers_structurally_match: false,
    answer_encoding: 'not_seen',
    tool_output_error_kind: 'not_seen',
    tool_output_type: 'unknown',
    tool_output_keys: [],
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    let url;
    try {
      url = new URL(request.url, 'http://127.0.0.1');
    } catch {
      request.resume();
      response.writeHead(400).end();
      return;
    }
    if (request.method !== 'POST' || !RESPONSE_PATHS.has(url.pathname)) {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    const address = server.address();
    const expectedHost = address && typeof address === 'object' ? `127.0.0.1:${address.port}` : '';
    const provided = request.headers['x-poc160-token'];
    const validToken = typeof provided === 'string'
      && Buffer.byteLength(provided) === Buffer.byteLength(secret)
      && timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    if (request.headers.host !== expectedHost || Object.hasOwn(request.headers, 'origin') || !validToken) {
      request.resume();
      response.writeHead(403).end();
      return;
    }
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      response.writeHead(error.statusCode || 400).end();
      return;
    }
    if (requests.length >= MAX_REQUESTS) {
      response.writeHead(429).end();
      return;
    }
    const toolInventory = sanitizeTools(body && body.tools);
    const requestUserInputDeclarations = discoverFunctions(body && body.tools)
      .filter((declaration) => declaration.localName === TOOL_NAME);
    requests.push({
      path: url.pathname,
      top_level_fields: fieldTypes(body),
      tool_names: toolInventory.map((tool) => tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name),
      tool_schema_keys: toolInventory.map((tool) => ({ name: tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name, keys: tool.schema_keys })),
      question_tool_declared: requestUserInputDeclarations.length > 0,
      question_tool_schema: requestUserInputDeclarations.length === 1
        ? questionSchemaSummary(requestUserInputDeclarations[0].schema)
        : null,
    });
    responseNumber += 1;
    if (!callState) {
      const plan = findQuestionCallPlan(body && body.tools, {
        blocking: options.blocking !== false,
        questionProfile,
      });
      if (plan.error) {
        unsupported = plan.error;
        writeEvents(response, makeFinalEvents(responseNumber));
        body = null;
        return;
      }
      const emitted = makeFunctionCallEvents(responseNumber, plan.value);
      callState = {
        itemId: emitted.itemId,
        callId: emitted.callId,
        callName: plan.value.name,
        callNamespace: plan.value.namespace || null,
        targetTool: plan.value.targetTool,
        targetNamespace: plan.value.targetNamespace || null,
        answerKind,
        modelToolBlockingDeclared: Object.hasOwn(plan.value.arguments, 'isBlocking'),
        questionIds: plan.value.questionIds,
        questionProfile,
        schemaSummary: plan.value.schemaSummary,
        isBlocking: Object.hasOwn(plan.value.arguments, 'isBlocking') ? plan.value.arguments.isBlocking : null,
        questionMeta: QUESTION_PROFILES[questionProfile].filter((question) => plan.value.questionIds.includes(question.id)).map((question) => ({
          id: question.id,
          option_count: question.options.length,
          free_form_enabled: question.isOther,
          secret: question.isSecret,
        })),
      };
      writeEvents(response, emitted.events);
      body = null;
      return;
    }
    answerOutput = inspectFixedAnswerOutput(body, callState.callId, callState.questionIds, callState.answerKind);
    writeEvents(response, makeFinalEvents(responseNumber));
    body = null;
  });

  const fixture = {
    server,
    get requestHeaders() { return { 'X-Poc160-Token': secret }; },
    get baseUrl() {
      const address = server.address();
      return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : null;
    },
    get requests() { return requests.map((request) => structuredClone(request)); },
    get unsupported() { return unsupported; },
    get callSummary() {
      if (!callState) return null;
      return {
        item_id_present: Boolean(callState.itemId),
        call_id_present: Boolean(callState.callId),
        item_id: callState.itemId,
        call_id: callState.callId,
        call_name: callState.callName,
        call_namespace: callState.callNamespace,
        target_tool: callState.targetTool,
        target_namespace: callState.targetNamespace,
        question_profile: callState.questionProfile,
        answer_kind: callState.answerKind,
        schema_summary: structuredClone(callState.schemaSummary),
        is_blocking: callState.isBlocking,
        model_tool_schema_is_blocking_declared: callState.modelToolBlockingDeclared,
        question_ids: [...callState.questionIds],
        questions: callState.questionMeta.map((question) => ({ ...question })),
      };
    },
    get answerOutput() { return { ...answerOutput }; },
    async start() {
      if (!server.listening) {
        await new Promise((resolve, reject) => {
          const onError = (error) => { server.off('listening', onListening); reject(error); };
          const onListening = () => { server.off('error', onError); resolve(); };
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

module.exports = {
  ANSWER_KINDS,
  ANSWER_VALUES,
  FINAL_TEXT,
  FIXTURE_MODEL,
  FIXED_FREE_TEXT_ANSWER,
  QUESTION_PROFILES,
  QUESTION_TEMPLATES,
  TOOL_NAME,
  buildQuestionArguments,
  createNativeQuestionFixture,
  findQuestionCallPlan,
  inspectFixedAnswerOutput,
  questionSchemaSummary,
};
