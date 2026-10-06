'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const {
  assertNoSymlinkComponents,
  resolveOutputDirectory,
  setup,
  REQUIRED_CODEX_VERSION,
  REPOSITORY_ROOT,
} = require('../codex-hooks-identity/setup');
const {
  clearFixtureConfig,
  createRuntimeHome,
  runVersionCheck,
  validatePaths,
} = require('../codex-hooks-identity/run-exec');
const {
  chooseLoopbackPort,
  cleanupFixtureConfigPreservingSuffix,
  makeServerArguments,
  startServerProcess,
} = require('../codex-shared-app-server/run-managed');
const {
  connectViaWebSocket,
  validateInitializeResponse,
} = require('../codex-shared-app-server/collector');
const {
  ANSWER_KINDS,
  createNativeQuestionFixture,
  FIXED_FREE_TEXT_ANSWER,
  QUESTION_PROFILES,
  QUESTION_TEMPLATES,
} = require('./native-fixture');
const FIXTURE_MODEL = require('./native-fixture').FIXTURE_MODEL;

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 60000;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_WAIT_MS = 20000;
const SERVER_STOP_MS = 3000;
const REQUEST_METHOD = 'item/tool/requestUserInput';
const QUESTION_METHODS = new Set([REQUEST_METHOD]);
const SERVER_METHOD_CATEGORIES = new Map([
  ['item/permissions/requestApproval', 'permission_approval'],
  ['item/commandExecution/requestApproval', 'command_approval'],
  ['item/fileChange/requestApproval', 'file_change_approval'],
]);
const JSON_RPC_METHODS = Object.freeze(['initialize', 'initialized', 'thread/start', 'turn/start']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TURN_STATUSES = new Set(['queued', 'inProgress', 'completed', 'failed', 'interrupted', 'cancelling']);
const RPC_ERROR_CATEGORIES = new Set([
  'thread_not_found', 'history_missing', 'not_initialized', 'experimental_required',
  'invalid_params', 'permission_denied', 'thread_not_persisted', 'resume_unavailable', 'unknown',
]);
const ITEM_TYPES = new Set([
  'userMessage', 'agentMessage', 'functionCallOutput', 'dynamicToolCall', 'mcpToolCall',
  'commandExecution', 'fileChange', 'reasoning', 'plan', 'collabAgentToolCall', 'subAgentActivity',
]);

class NativeQuestionError extends Error {
  constructor(kind) {
    super(kind);
    this.name = 'NativeQuestionError';
    this.kind = kind;
  }
}

function usage() {
  return 'Usage: node native-runner.js --codex-path <codex.exe> --out poc/out/<fresh-slug> [--timeout-ms 30000] [--blocking true|false] [--question-profile full|single] [--answer-kind choice|free-text] [--mode default|plan]';
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--codex-path', '--out', '--timeout-ms', '--blocking', '--question-profile', '--answer-kind', '--mode'].includes(option)
      || values.has(option) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new NativeQuestionError('invalid_arguments');
    }
    values.set(option, argv[index + 1]);
    index += 1;
  }
  if (!values.has('--codex-path') || !values.has('--out')) throw new NativeQuestionError('invalid_arguments');
  const timeoutMs = values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new NativeQuestionError('invalid_timeout');
  }
  const blocking = values.has('--blocking') ? values.get('--blocking') : 'true';
  if (!['true', 'false'].includes(blocking)) throw new NativeQuestionError('invalid_blocking');
  const questionProfile = values.get('--question-profile') || 'full';
  if (!Object.hasOwn(QUESTION_PROFILES, questionProfile)) throw new NativeQuestionError('invalid_question_profile');
  const answerKind = values.get('--answer-kind') || 'choice';
  if (!ANSWER_KINDS.includes(answerKind)) throw new NativeQuestionError('invalid_answer_kind');
  const mode = values.get('--mode') || 'default';
  if (!['default', 'plan'].includes(mode)) throw new NativeQuestionError('invalid_mode');
  return {
    codexPath: values.get('--codex-path'),
    outputDirectory: values.get('--out'),
    timeoutMs,
    blocking: blocking === 'true',
    questionProfile,
    answerKind,
    mode,
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeErrorKind(error, fallback = 'native_probe_failed') {
  const candidate = error && (error.kind || error.code);
  return typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(candidate) ? candidate : fallback;
}

function safeUuid(value) {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function requestIdKey(value) {
  if (typeof value === 'string' && REQUEST_ID.test(value)) return `s:${value}`;
  if (Number.isSafeInteger(value) && value >= 0) return `n:${value}`;
  return null;
}

function fixedAnswerPayload(questionIds = QUESTION_TEMPLATES.map((question) => question.id), answerKind = 'choice') {
  return Object.fromEntries(QUESTION_TEMPLATES.filter((question) => questionIds.includes(question.id))
    .map((question) => [question.id, { answers: [answerKind === 'free-text' ? FIXED_FREE_TEXT_ANSWER : question.options[0].label] }]));
}

function fixtureRequestItemIdKind(value, callSummary) {
  if (!callSummary || callSummary.target_tool !== 'request_user_input') return 'unknown';
  if (value === callSummary.item_id) return 'output_item_id';
  if (value === callSummary.call_id) return 'function_call_id';
  return 'unknown';
}

function exactKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
}

function projectQuestionRequest(params, expected) {
  const questionIds = expected.questionIds || QUESTION_TEMPLATES.map((question) => question.id);
  const expectedQuestions = questionIds.map((id) => QUESTION_TEMPLATES.find((question) => question.id === id)).filter(Boolean);
  const result = {
    schema_supported: false,
    thread_matches: false,
    turn_matches: false,
    fixture_item_matches: false,
    fixture_call_id_matches: false,
    correlated_id_kind: 'unknown',
    model_tool_schema_is_other_declared: expected.modelToolSchema?.is_other_declared === true,
    is_blocking: null,
    question_count: 0,
    question_ids: [],
    questions: [],
    answer_kind_eligible: false,
    origin: 'unknown',
    rejection: 'request_schema_unsupported',
  };
  const allowedTopLevel = new Set(['threadId', 'turnId', 'itemId', 'isBlocking', 'questions', 'autoResolutionMs']);
  if (expectedQuestions.length !== questionIds.length || !exactKeys(params, allowedTopLevel)
    || !safeUuid(params.threadId) || !safeUuid(params.turnId)
    || typeof params.itemId !== 'string' || params.itemId.length > 128 || typeof params.isBlocking !== 'boolean'
    || !Array.isArray(params.questions) || params.questions.length !== expectedQuestions.length
    || (Object.hasOwn(params, 'autoResolutionMs') && params.autoResolutionMs !== null)) {
    return result;
  }
  result.thread_matches = params.threadId === expected.threadId;
  result.turn_matches = Boolean(expected.turnId && params.turnId === expected.turnId);
  result.fixture_item_matches = params.itemId === expected.fixtureItemId;
  result.fixture_call_id_matches = Boolean(expected.fixtureCallId && params.itemId === expected.fixtureCallId);
  result.correlated_id_kind = result.fixture_item_matches ? 'output_item_id'
    : result.fixture_call_id_matches ? 'function_call_id' : 'unknown';
  result.is_blocking = params.isBlocking;
  result.question_count = params.questions.length;
  let allQuestionsMatch = true;
  for (let index = 0; index < params.questions.length; index += 1) {
    const question = params.questions[index];
    const template = expectedQuestions[index];
    const allowedQuestion = new Set(['id', 'header', 'question', 'options', 'isOther', 'isSecret']);
    if (!exactKeys(question, allowedQuestion) || typeof question.id !== 'string'
      || typeof question.header !== 'string' || typeof question.question !== 'string') {
      return result;
    }
    const options = question.options;
    if (!Array.isArray(options) || options.length !== template.options.length
      || options.some((option) => !exactKeys(option, new Set(['label', 'description']))
        || typeof option.label !== 'string' || typeof option.description !== 'string')) {
      return result;
    }
    const modelIsOtherDeclared = expected.modelToolSchema?.is_other_declared === true;
    const modelIsSecretDeclared = expected.modelToolSchema?.is_secret_declared === true;
    const isOther = question.isOther === undefined ? null : question.isOther;
    const isSecret = question.isSecret === undefined ? false : question.isSecret;
    if ((isOther !== null && typeof isOther !== 'boolean') || typeof isSecret !== 'boolean') return result;
    const labelsMatch = options.every((option, optionIndex) => option.label === template.options[optionIndex].label);
    const isOtherMatches = modelIsOtherDeclared ? isOther === template.isOther : null;
    const isSecretMatches = modelIsSecretDeclared ? isSecret === template.isSecret : !isSecret;
    const matches = question.id === template.id && options.length === template.options.length
      && (!modelIsOtherDeclared || isOtherMatches) && isSecretMatches && labelsMatch;
    allQuestionsMatch = allQuestionsMatch && matches;
    result.question_ids.push(question.id === template.id ? template.id : 'unknown');
    result.questions.push({
      id: question.id === template.id ? template.id : 'unknown',
      option_count: options.length,
      free_form_enabled: isOther,
      free_form_source: isOther === null ? 'not_observed' : modelIsOtherDeclared ? 'model_schema' : 'runtime_added',
      is_other_matches_model_schema: isOtherMatches,
      secret: isSecret,
      template_match: matches,
    });
  }
  result.schema_supported = allQuestionsMatch;
  result.origin = result.correlated_id_kind !== 'unknown' && expected.fixtureTool === 'request_user_input'
    ? 'fixture_call_correlated'
    : 'unknown';
  const questionShapeMatches = result.schema_supported && result.thread_matches
    && result.correlated_id_kind !== 'unknown' && result.origin === 'fixture_call_correlated';
  const freeTextAvailable = result.questions.length > 0
    && result.questions.every((question) => question.free_form_enabled === true && !question.secret);
  result.answer_kind_eligible = (expected.answerKind || 'choice') !== 'free-text' || freeTextAvailable;
  result.rejection = questionShapeMatches
    ? !result.turn_matches ? 'turn_identity_unverified'
      : !result.answer_kind_eligible ? 'free_text_not_enabled' : null
    : result.questions.some((question) => question.secret) ? 'secret_question_unsupported'
      : 'origin_or_identity_unverified';
  return result;
}

function questionFlowSucceeded(fixtureCall, nativeQuestion, fixtureAnswer) {
  return Boolean(fixtureCall && nativeQuestion.question_origin === 'fixture_call_correlated'
    && nativeQuestion.question_schema_supported && nativeQuestion.thread_id_match && nativeQuestion.turn_id_match
    && ['output_item_id', 'function_call_id'].includes(nativeQuestion.correlated_id_kind)
    && nativeQuestion.response_sent_count === 1
    && nativeQuestion.correlated_resolved_request_count === 1 && nativeQuestion.turn_status === 'completed'
    && fixtureAnswer.answers_structurally_match === true);
}

function classifyQuestionOutcome({ fixtureUnsupported, terminal, fixtureCall, nativeQuestion, fixtureAnswer }) {
  if (fixtureUnsupported && terminal) {
    const toolUnavailable = fixtureUnsupported === 'request_user_input_unavailable';
    return {
      outcome: toolUnavailable ? 'tool_unavailable' : 'fixture_input_profile_unsupported',
      questionsSupported: toolUnavailable ? false : null,
      flowSucceeded: false,
    };
  }
  if (questionFlowSucceeded(fixtureCall, nativeQuestion, fixtureAnswer)) {
    return { outcome: 'answered', questionsSupported: true, flowSucceeded: true };
  }
  if (fixtureAnswer.call_output_seen && nativeQuestion.question_request_count === 0) {
    if (fixtureAnswer.tool_output_error_kind === 'default_mode_unavailable') {
      return { outcome: 'default_mode_unavailable', questionsSupported: false, flowSucceeded: false };
    }
    if (['question_tool_unavailable', 'question_tool_unrecognized'].includes(fixtureAnswer.tool_output_error_kind)) {
      return { outcome: 'tool_unavailable', questionsSupported: false, flowSucceeded: false };
    }
    return { outcome: 'native_dispatch_not_observed', questionsSupported: null, flowSucceeded: false };
  }
  return { outcome: 'unverified', questionsSupported: null, flowSucceeded: false };
}

function classifyServerMethod(method, fixtureIdentityMatched) {
  if (QUESTION_METHODS.has(method)) return fixtureIdentityMatched ? 'fixture_question' : 'unknown_question_or_app_approval';
  if (SERVER_METHOD_CATEGORIES.has(method)) return SERVER_METHOD_CATEGORIES.get(method);
  return 'other_request';
}

function createQuestionRpcLedger(client, fixture, expected = {}) {
  if (!client || typeof client.sendJson !== 'function' || typeof client.dispatchText !== 'function') {
    throw new NativeQuestionError('question_rpc_client_unsupported');
  }
  const state = {
    threadId: expected.threadId || null,
    expectedTurnId: expected.turnId || null,
    turnStartedIds: new Set(),
    terminalTurnStatuses: [],
    requestCount: 0,
    responseSentCount: 0,
    resolvedCount: 0,
    correlatedResolvedCount: 0,
    unresolvedCount: 0,
    requestCategories: {
      fixture_question: 0,
      unknown_question_or_app_approval: 0,
      permission_approval: 0,
      command_approval: 0,
      file_change_approval: 0,
      other_request: 0,
    },
    requestIds: new Set(),
    questionRequestIds: new Set(),
    seenServerRequestIds: new Set(),
    responseAttemptedIds: new Set(),
    resolvedIds: new Set(),
    questionResolvedIds: new Set(),
    pendingQuestion: null,
    duplicateQuestionRequestCount: 0,
    question: null,
    requestedMode: expected.requestedMode || null,
    answerKind: expected.answerKind || 'choice',
    observedModes: [],
    fixtureItemStarted: false,
    fixtureItemCompleted: false,
    fixtureItemType: null,
    malformedMessageCount: 0,
  };
  const originalDispatch = client.dispatchText.bind(client);

  client.dispatchText = function dispatchQuestionAwareText(payload) {
    let message;
    try {
      const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('large');
      message = JSON.parse(text);
    } catch {
      state.malformedMessageCount += 1;
      return originalDispatch(payload);
    }
    if (!isRecord(message) || typeof message.method !== 'string') return originalDispatch(payload);
    const params = isRecord(message.params) ? message.params : {};
    if (Object.hasOwn(message, 'id')) {
      state.requestCount += 1;
      const preliminaryIdentityMatch = message.method === REQUEST_METHOD
        && fixtureRequestItemIdKind(params.itemId, fixture.callSummary) !== 'unknown';
      const category = classifyServerMethod(message.method, preliminaryIdentityMatch);
      state.requestCategories[category] = (state.requestCategories[category] || 0) + 1;
      const requestKey = requestIdKey(message.id);
      if (requestKey && state.seenServerRequestIds.has(requestKey)) {
        if (message.method === REQUEST_METHOD) state.duplicateQuestionRequestCount += 1;
        return originalDispatch(payload);
      }
      if (requestKey) state.seenServerRequestIds.add(requestKey);
      if (requestKey) state.requestIds.add(requestKey);
      if (message.method === REQUEST_METHOD && requestKey && fixture.callSummary) {
        const turnId = safeUuid(params.turnId);
        const observedTurnIds = [...state.turnStartedIds];
        const expectedTurnId = state.expectedTurnId || (observedTurnIds.length === 1 ? observedTurnIds[0] : null);
        const projection = projectQuestionRequest(params, {
          threadId: state.threadId,
          turnId: expectedTurnId,
          fixtureItemId: fixture.callSummary.item_id,
          fixtureCallId: fixture.callSummary.call_id,
          fixtureTool: fixture.callSummary.target_tool,
          modelToolSchema: fixture.callSummary.schema_summary,
          answerKind: state.answerKind,
          questionIds: fixture.callSummary.question_ids,
        });
        state.question = projection;
        if (requestKey && projection.schema_supported && projection.thread_matches
          && projection.correlated_id_kind !== 'unknown' && projection.turn_matches
          && projection.answer_kind_eligible && projection.origin === 'fixture_call_correlated') {
          state.questionRequestIds.add(requestKey);
        }
        if (projection.rejection === null) {
          submitQuestionAnswer(client, state, message.id, requestKey, projection);
        } else if (projection.rejection === 'turn_identity_unverified' && turnId) {
          state.pendingQuestion = { id: message.id, key: requestKey, turnId, projection };
        }
      }
      return originalDispatch(payload);
    }
    if (message.method === 'turn/started') {
      const turn = isRecord(params.turn) ? params.turn : params;
      const turnId = safeUuid(params.turnId || turn.id);
      if (turnId) state.turnStartedIds.add(turnId);
    } else if (message.method === 'turn/completed') {
      const turn = isRecord(params.turn) ? params.turn : params;
      const turnId = safeUuid(params.turnId || turn.id);
      const status = TURN_STATUSES.has(turn.status) ? turn.status : 'unknown';
      if (turnId) state.terminalTurnStatuses.push({ id: turnId, status });
    } else if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = isRecord(params.item) ? params.item : {};
      const call = fixture.callSummary;
      if (call && item.id === call.item_id && item.name === call.call_name
        && (item.namespace || null) === (call.call_namespace || null)) {
        if (message.method === 'item/started') state.fixtureItemStarted = true;
        else state.fixtureItemCompleted = true;
        state.fixtureItemType = ITEM_TYPES.has(item.type) ? item.type : 'unknown';
      }
    } else if (message.method === 'serverRequest/resolved') {
      state.resolvedCount += 1;
      const resolvedKey = requestIdKey(params.requestId);
      if (resolvedKey && state.questionRequestIds.has(resolvedKey)) {
        if (!state.questionResolvedIds.has(resolvedKey)) state.correlatedResolvedCount += 1;
        state.questionResolvedIds.add(resolvedKey);
      } else if (resolvedKey && state.requestIds.has(resolvedKey)) {
        state.resolvedIds.add(resolvedKey);
      } else {
        state.unresolvedCount += 1;
      }
    } else if (message.method === 'thread/settings/updated' && params.threadId === state.threadId) {
      const threadSettings = isRecord(params.threadSettings) ? params.threadSettings : {};
      const mode = isRecord(threadSettings.collaborationMode) ? threadSettings.collaborationMode : {};
      const settings = isRecord(mode.settings) ? mode.settings : {};
      if (mode.mode === 'plan' || mode.mode === 'default') {
        state.observedModes.push({
          mode: mode.mode,
          model_matches_fixture: settings.model === FIXTURE_MODEL,
          developer_instructions_null: settings.developer_instructions === null,
          reasoning_effort_null: settings.reasoning_effort === null,
        });
      }
    }
    return originalDispatch(payload);
  };
  return state;
}

function submitQuestionAnswer(client, state, requestId, requestKey, projection) {
  if (!requestKey || state.responseAttemptedIds.has(requestKey) || projection.rejection !== null) return false;
  state.responseAttemptedIds.add(requestKey);
  const response = { id: requestId, result: { answers: fixedAnswerPayload(projection.question_ids, state.answerKind) } };
  queueMicrotask(() => client.sendJson(response).then(() => {
    state.responseSentCount += 1;
  }).catch(() => {
    state.responseAttemptedIds.delete(requestKey);
  }));
  return true;
}

function bindQuestionTurn(state, client, turnId) {
  const expectedTurnId = safeUuid(turnId);
  if (!expectedTurnId) return false;
  state.expectedTurnId = expectedTurnId;
  const pending = state.pendingQuestion;
  if (!pending) return true;
  state.pendingQuestion = null;
  pending.projection.turn_matches = pending.turnId === expectedTurnId;
  pending.projection.rejection = !pending.projection.turn_matches ? 'turn_identity_mismatch'
    : !pending.projection.answer_kind_eligible ? 'free_text_not_enabled' : null;
  state.question = pending.projection;
  if (pending.projection.rejection === null) {
    if (pending.projection.schema_supported && pending.projection.thread_matches
      && pending.projection.correlated_id_kind !== 'unknown'
      && pending.projection.answer_kind_eligible
      && pending.projection.origin === 'fixture_call_correlated') {
      state.questionRequestIds.add(pending.key);
    }
    submitQuestionAnswer(client, state, pending.id, pending.key, pending.projection);
  }
  return pending.projection.rejection === null;
}

function summarizeRpcLedger(state, fixtureCall, turnId) {
  const question = state.question;
  const resolvedForQuestion = question && state.correlatedResolvedCount;
  const status = [...state.terminalTurnStatuses].reverse().find((entry) => entry.id === turnId)?.status || 'unknown';
  const observedMode = state.observedModes.at(-1) || null;
  return {
    requested_mode: state.requestedMode || 'unknown',
    answer_kind: state.answerKind,
    observed_mode: observedMode?.mode || 'unknown',
    observed_mode_matches_request: observedMode ? observedMode.mode === state.requestedMode : null,
    mode_update_count: state.observedModes.length,
    observed_mode_model_matches_fixture: observedMode?.model_matches_fixture ?? null,
    server_request_counts: { ...state.requestCategories },
    question_request_count: state.requestCategories.fixture_question + state.requestCategories.unknown_question_or_app_approval,
    question_origin: question?.origin || 'unknown',
    question_schema_supported: question?.schema_supported === true,
    thread_id_match: question?.thread_matches === true,
    turn_id_match: question?.turn_matches === true,
    fixture_item_match: question?.fixture_item_matches === true,
    fixture_call_id_match: question?.fixture_call_id_matches === true,
    correlated_id_kind: question?.correlated_id_kind || 'unknown',
    model_tool_schema_is_other_declared: question?.model_tool_schema_is_other_declared === true,
    item_started_observed: state.fixtureItemStarted,
    item_completed_observed: state.fixtureItemCompleted,
    item_type: state.fixtureItemType || 'unknown',
    model_tool_schema_is_blocking_declared: fixtureCall?.model_tool_schema_is_blocking_declared === true,
    model_tool_is_blocking: fixtureCall?.model_tool_schema_is_blocking_declared ? fixtureCall.is_blocking : null,
    native_is_blocking: question?.is_blocking ?? null,
    question_count: question?.question_count || 0,
    answer_kind_eligible: question?.answer_kind_eligible ?? null,
    question_ids: question?.question_ids || [],
    questions: question?.questions || [],
    response_sent_count: state.responseSentCount,
    duplicate_question_request_count: state.duplicateQuestionRequestCount,
    resolved_request_count: state.resolvedCount,
    correlated_resolved_request_count: resolvedForQuestion || 0,
    uncorrelated_resolved_request_count: state.unresolvedCount,
    turn_status: status,
    turn_terminal_observed: status !== 'unknown',
    malformed_rpc_message_count: state.malformedMessageCount,
  };
}

function configureNativeFixture(layout, fixture) {
  const configPath = layout.configPath;
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NativeQuestionError('private_config_invalid');
  const originalConfig = fs.readFileSync(configPath, 'utf8');
  const header = fixture.requestHeaders['X-Poc160-Token'];
  if (typeof header !== 'string' || !/^[0-9a-f]{64}$/.test(header) || !fixture.baseUrl) {
    throw new NativeQuestionError('fixture_connection_details_invalid');
  }
  const quote = (value) => JSON.stringify(value);
  const appliedConfig = [
    `model = ${quote(FIXTURE_MODEL)}`,
    'model_provider = "poc160_fixture"',
    '',
    '[model_providers.poc160_fixture]',
    'name = "Local deterministic question fixture"',
    `base_url = ${quote(fixture.baseUrl)}`,
    'wire_api = "responses"',
    `http_headers = { "X-Poc160-Token" = ${quote(header)} }`,
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n');
  assertNoSymlinkComponents(layout.output, configPath);
  const temporary = `${configPath}.poc160-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, appliedConfig, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {
    output: layout.output,
    isolatedHome: layout.home,
    configPath,
    originalConfig,
    appliedConfig,
  };
}

function createTokenFile(output, randomBytesImpl = randomBytes) {
  const token = randomBytesImpl(32).toString('hex');
  const tokenPath = path.join(output, `.poc160-token-${randomUUID()}`);
  assertNoSymlinkComponents(output, tokenPath);
  fs.writeFileSync(tokenPath, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const fileContents = fs.readFileSync(tokenPath, 'utf8');
  if (fileContents !== token) throw new NativeQuestionError('capability_token_file_invalid');
  return { token, tokenPath, hash: createHash('sha256').update(token).digest('hex') };
}

function removeTokenFile(tokenFile) {
  if (!tokenFile) return true;
  try {
    const stat = fs.lstatSync(tokenFile.tokenPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const content = fs.readFileSync(tokenFile.tokenPath, 'utf8');
    if (createHash('sha256').update(content).digest('hex') !== tokenFile.hash) return false;
    fs.unlinkSync(tokenFile.tokenPath);
    return true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

function removeRuntimeHome(output, home) {
  if (!home) return true;
  const resolvedOutput = resolveOutputDirectory(output);
  const expectedParent = path.join(resolvedOutput, 'runtime-homes');
  const resolvedHome = path.resolve(home);
  const relative = path.relative(expectedParent, resolvedHome);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.dirname(resolvedHome) !== expectedParent || !UUID.test(path.basename(resolvedHome))) return false;
  try {
    assertNoSymlinkComponents(REPOSITORY_ROOT, expectedParent);
    assertNoSymlinkComponents(expectedParent, resolvedHome);
    const stat = fs.lstatSync(resolvedHome);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    fs.rmSync(resolvedHome, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
    return !fs.existsSync(resolvedHome);
  } catch {
    return false;
  }
}

async function stopServer(server) {
  if (!server || server.state.closed) return true;
  try { server.child.kill(); } catch { return false; }
  return Promise.race([
    server.exited.then(() => true),
    delay(SERVER_STOP_MS).then(() => false),
  ]);
}

function emptyResult(options) {
  return {
    schema: 'agent-cockpit-poc160-native-v1',
    backend: { source: 'local_responses_fixture', model: FIXTURE_MODEL, real_model_observed: false },
    target_version: null,
    runner_mode: 'owned_app_server_rpc_client',
    requested_mode: options.mode,
    observed_mode: 'unknown',
    observed_mode_matches_request: null,
    question_profile: options.questionProfile,
    answer_kind: options.answerKind,
    requested_blocking: options.blocking,
    measurement_observed: false,
    experiment_completed: false,
    questions_supported: null,
    outcome: 'unverified',
    success: false,
    failure_reasons: [],
    failure_stage: null,
    failure_rpc_category: null,
    fixture: {
      request_count: 0,
      tool_names: [],
      question_tool_declared: false,
      question_tool_schema: null,
      question_count: 0,
      question_profile: options.questionProfile,
      answer_kind: options.answerKind,
      fixture_function_call_emitted: false,
      unsupported: null,
      request_user_input_tool_blocking_declared: null,
      request_user_input_tool_is_blocking: null,
      answer_output_seen: false,
      fixed_answer_strings_present: false,
      answers_structurally_match: false,
      answer_encoding: 'not_seen',
      tool_output_error_kind: 'not_seen',
      tool_output_type: 'unknown',
      tool_output_keys: [],
    },
    native_question: {
      server_request_counts: { fixture_question: 0, unknown_question_or_app_approval: 0, permission_approval: 0, command_approval: 0, file_change_approval: 0, other_request: 0 },
      requested_mode: options.mode,
      answer_kind: options.answerKind,
      observed_mode: 'unknown',
      observed_mode_matches_request: null,
      mode_update_count: 0,
      question_request_count: 0,
      question_origin: 'unknown',
      question_schema_supported: false,
      thread_id_match: false,
      turn_id_match: false,
      fixture_item_match: false,
      fixture_call_id_match: false,
      correlated_id_kind: 'unknown',
      model_tool_schema_is_other_declared: null,
      item_started_observed: false,
      item_completed_observed: false,
      item_type: 'unknown',
      model_tool_schema_is_blocking_declared: null,
      model_tool_is_blocking: null,
      native_is_blocking: null,
      question_count: 0,
      answer_kind_eligible: null,
      question_ids: [],
      questions: [],
      response_sent_count: 0,
      resolved_request_count: 0,
      correlated_resolved_request_count: 0,
      uncorrelated_resolved_request_count: 0,
      turn_status: 'unknown',
      turn_terminal_observed: false,
      malformed_rpc_message_count: 0,
    },
    cleanup: {
      connection_closed: false,
      server_stopped: false,
      fixture_closed: false,
      config_restored: false,
      fixture_config_removed: false,
      appended_config_preserved: false,
      token_removed: false,
      native_home_removed: false,
      signal_handlers_removed: false,
    },
    native_home: null,
    output_directory: null,
  };
}

function writeResult(output, result) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) throw new NativeQuestionError('result_too_large');
  const filePath = path.join(output, `native-question-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID()}.json`);
  assertNoSymlinkComponents(REPOSITORY_ROOT, filePath);
  fs.writeFileSync(filePath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return filePath;
}

async function waitForTurnTerminal(ledger, turnId, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, MAX_WAIT_MS);
  while (Date.now() < deadline) {
    if (ledger.terminalTurnStatuses.some((entry) => entry.id === turnId)) return true;
    await delay(50);
  }
  return ledger.terminalTurnStatuses.some((entry) => entry.id === turnId);
}

async function connectUntilReady(options, server, dependencies = {}) {
  const connect = dependencies.connect || connectViaWebSocket;
  const deadline = Date.now() + Math.min(options.timeoutMs, 15000);
  let lastError = null;
  while (Date.now() < deadline) {
    if (server.state.closed) throw new NativeQuestionError('app_server_exited_before_connect');
    try {
      return await connect({
        url: `ws://127.0.0.1:${options.port}`,
        authToken: options.token,
        timeoutMs: Math.min(3000, options.timeoutMs),
        allowedMethods: JSON_RPC_METHODS,
      });
    } catch (error) {
      lastError = error;
      await delay(150);
    }
  }
  throw new NativeQuestionError(lastError ? safeErrorKind(lastError, 'app_server_connect_failed') : 'app_server_connect_timeout');
}

async function runNativeProbe(options, dependencies = {}) {
  const normalized = {
    ...options,
    timeoutMs: Number.isInteger(options && options.timeoutMs) ? Math.min(Math.max(options.timeoutMs, 1000), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    blocking: options && typeof options.blocking === 'boolean' ? options.blocking : true,
    questionProfile: options && Object.hasOwn(QUESTION_PROFILES, options.questionProfile) ? options.questionProfile : 'full',
    answerKind: options && ANSWER_KINDS.includes(options.answerKind) ? options.answerKind : 'choice',
    mode: options && ['default', 'plan'].includes(options.mode) ? options.mode : 'default',
  };
  const result = emptyResult(normalized);
  let output = null;
  let sourceLayout = null;
  let layout = null;
  let fixture = null;
  let configSnapshot = null;
  let tokenFile = null;
  let server = null;
  let connection = null;
  let rpcLedger = null;
  let signalRequested = false;
  let currentStage = 'output_validation';
  const signalSource = dependencies.signalSource || process;
  const onSignal = () => {
    signalRequested = true;
    try { if (server && !server.state.closed) server.child.kill(); } catch { }
  };
  signalSource.on('SIGINT', onSignal);
  signalSource.on('SIGTERM', onSignal);
  try {
    output = resolveOutputDirectory(normalized.outputDirectory);
    assertNoSymlinkComponents(REPOSITORY_ROOT, output);
    currentStage = 'setup';
    sourceLayout = (dependencies.setup || setup)({
      outputDirectory: path.relative(REPOSITORY_ROOT, output).split(path.sep).join('/'),
      codexVersion: REQUIRED_CODEX_VERSION,
    });
    currentStage = 'path_validation';
    const paths = (dependencies.validatePaths || validatePaths)(normalized.codexPath, path.relative(REPOSITORY_ROOT, output).split(path.sep).join('/'));
    currentStage = 'runtime_home';
    layout = (dependencies.createRuntimeHome || createRuntimeHome)(paths.layout);
    result.output_directory = path.relative(REPOSITORY_ROOT, output).split(path.sep).join('/');
    result.native_home = path.relative(output, layout.home).split(path.sep).join('/');

    currentStage = 'fixture_start';
    fixture = (dependencies.createFixture || createNativeQuestionFixture)({
      blocking: normalized.blocking,
      questionProfile: normalized.questionProfile,
      answerKind: normalized.answerKind,
    });
    await fixture.start();
    currentStage = 'version_check';
    const version = await (dependencies.runVersionCheck || runVersionCheck)(paths.executable, layout.home, {
      cwd: layout.repo,
      timeoutMs: normalized.timeoutMs,
    });
    result.target_version = version && version.version || null;
    if (!version || version.version !== REQUIRED_CODEX_VERSION) throw new NativeQuestionError('unsupported_native_version');

    currentStage = 'config_apply';
    configSnapshot = configureNativeFixture(layout, fixture);
    currentStage = 'app_server_start';
    const port = await (dependencies.choosePort || chooseLoopbackPort)();
    tokenFile = createTokenFile(output, dependencies.randomBytes || randomBytes);
    const startProcess = dependencies.startServer || startServerProcess;
    server = startProcess(paths.executable, layout.repo, layout.home, port, tokenFile.tokenPath);
    currentStage = 'app_server_connect';
    const connected = await connectUntilReady({
      timeoutMs: normalized.timeoutMs,
      port,
      token: tokenFile.token,
    }, server, dependencies);
    connection = connected;
    const client = connection.client;
    if (!client || typeof client.request !== 'function' || typeof client.notify !== 'function') {
      throw new NativeQuestionError('app_server_client_invalid');
    }
    currentStage = 'initialize';
    const initialize = await client.request('initialize', {
      clientInfo: { name: 'agent-cockpit-poc160-native', title: 'Native question fixture', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    const initializedMetadata = validateInitializeResponse(initialize);
    result.target_version = initializedMetadata.version;
    if (initializedMetadata.version !== REQUIRED_CODEX_VERSION) throw new NativeQuestionError('unsupported_native_version');
    await client.notify('initialized', {});
    currentStage = 'thread_start';
    const started = await client.request('thread/start', {
      cwd: layout.repo,
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      ephemeral: true,
    });
    const threadId = safeUuid(started && started.thread && started.thread.id);
    if (!threadId) throw new NativeQuestionError('thread_start_response_invalid');
    rpcLedger = createQuestionRpcLedger(client, fixture, {
      threadId,
      requestedMode: normalized.mode,
      answerKind: normalized.answerKind,
    });
    currentStage = 'turn_start';
    const turnResponse = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Use the available request_user_input tool once with the fixed question. Do not invoke any other tool.' }],
      collaborationMode: {
        mode: normalized.mode,
        settings: { model: FIXTURE_MODEL, reasoning_effort: null, developer_instructions: null },
      },
    });
    const turnId = safeUuid(turnResponse && turnResponse.turn && turnResponse.turn.id);
    if (!turnId) throw new NativeQuestionError('turn_start_response_invalid');
    bindQuestionTurn(rpcLedger, client, turnId);
    currentStage = 'wait_turn';
    const terminal = await waitForTurnTerminal(rpcLedger, turnId, normalized.timeoutMs);
    const fixtureCall = fixture.callSummary;
    const nativeQuestion = summarizeRpcLedger(rpcLedger, fixtureCall, turnId);
    const fixtureAnswer = fixture.answerOutput;
    result.fixture = {
      request_count: fixture.requests.length,
      tool_names: [...new Set(fixture.requests.flatMap((request) => request.tool_names))].sort().slice(0, 48),
      question_tool_declared: fixture.requests.some((request) => request.question_tool_declared),
      question_tool_schema: fixture.requests.find((request) => request.question_tool_declared)?.question_tool_schema || null,
      question_profile: normalized.questionProfile,
      answer_kind: normalized.answerKind,
      question_count: fixtureCall?.question_ids.length || 0,
      fixture_function_call_emitted: Boolean(fixtureCall),
      unsupported: fixture.unsupported || null,
      request_user_input_tool_blocking_declared: fixtureCall?.model_tool_schema_is_blocking_declared
        ?? (fixture.requests.find((request) => request.question_tool_declared)?.question_tool_schema?.is_blocking_declared ?? null),
      request_user_input_tool_is_blocking: fixtureCall?.model_tool_schema_is_blocking_declared ? fixtureCall.is_blocking : null,
      answer_output_seen: fixtureAnswer.call_output_seen,
      fixed_answer_strings_present: fixtureAnswer.fixed_answer_strings_present,
      answers_structurally_match: fixtureAnswer.answers_structurally_match,
      answer_encoding: fixtureAnswer.answer_encoding,
      tool_output_error_kind: fixtureAnswer.tool_output_error_kind,
      tool_output_type: fixtureAnswer.tool_output_type,
      tool_output_keys: fixtureAnswer.tool_output_keys,
      answer_order_observed: false,
    };
    result.native_question = nativeQuestion;
    result.observed_mode = nativeQuestion.observed_mode;
    result.observed_mode_matches_request = nativeQuestion.observed_mode_matches_request;
    result.measurement_observed = fixture.requests.length > 0 || nativeQuestion.question_request_count > 0;
    result.experiment_completed = terminal;
    const questionOutcome = classifyQuestionOutcome({
      fixtureUnsupported: fixture.unsupported,
      terminal,
      fixtureCall,
      nativeQuestion,
      fixtureAnswer,
    });
    result.outcome = questionOutcome.outcome;
    result.questions_supported = questionOutcome.questionsSupported;
    if (!questionOutcome.flowSucceeded && result.outcome === 'unverified') result.failure_reasons.push('question_flow_not_confirmed');
    if (!terminal) result.failure_reasons.push('turn_terminal_timeout');
    if (signalRequested) result.failure_reasons.push('interrupted');
  } catch (error) {
    result.failure_stage = currentStage;
    result.failure_rpc_category = RPC_ERROR_CATEGORIES.has(error && error.rpcErrorCategory)
      ? error.rpcErrorCategory
      : null;
    result.failure_reasons.push(safeErrorKind(error, `${currentStage}_failed`));
  } finally {
    try {
      if (connection && typeof connection.close === 'function') {
        await Promise.resolve(connection.close());
        result.cleanup.connection_closed = true;
      }
    } catch { result.failure_reasons.push('connection_cleanup_failed'); }
    try {
      result.cleanup.server_stopped = await stopServer(server);
    } catch { result.cleanup.server_stopped = false; }
    try {
      if (fixture && typeof fixture.close === 'function') {
        await fixture.close();
        result.cleanup.fixture_closed = true;
      }
    } catch { result.cleanup.fixture_closed = false; }
    if (configSnapshot) {
      try {
        const cleanup = cleanupFixtureConfigPreservingSuffix(configSnapshot.configPath, configSnapshot);
        result.cleanup.config_restored = cleanup.config_restored;
        result.cleanup.fixture_config_removed = cleanup.fixture_config_removed;
        result.cleanup.appended_config_preserved = cleanup.appended_config_preserved;
      } catch { result.cleanup.config_restored = false; }
    }
    result.cleanup.token_removed = removeTokenFile(tokenFile);
    result.cleanup.native_home_removed = removeRuntimeHome(output, layout && layout.home);
    const removeListener = typeof signalSource.off === 'function'
      ? signalSource.off.bind(signalSource)
      : signalSource.removeListener.bind(signalSource);
    removeListener('SIGINT', onSignal);
    removeListener('SIGTERM', onSignal);
    result.cleanup.signal_handlers_removed = !signalSource.listeners('SIGINT').includes(onSignal)
      && !signalSource.listeners('SIGTERM').includes(onSignal);
  }
  result.success = result.target_version === REQUIRED_CODEX_VERSION && result.outcome === 'answered'
    && result.measurement_observed && result.experiment_completed && result.failure_reasons.length === 0
    && result.cleanup.server_stopped && result.cleanup.fixture_closed && result.cleanup.config_restored
    && result.cleanup.fixture_config_removed && result.cleanup.appended_config_preserved
    && result.cleanup.token_removed && result.cleanup.native_home_removed && result.cleanup.signal_handlers_removed;
  if (output) {
    const filePath = writeResult(output, result);
    return { filePath, result };
  }
  return { filePath: null, result };
}

async function main(argv) {
  const options = parseArguments(argv);
  const { filePath, result } = await runNativeProbe(options);
  process.stdout.write(`${JSON.stringify({
    file: filePath ? path.relative(REPOSITORY_ROOT, filePath).split(path.sep).join('/') : null,
    success: result.success,
    measurement_observed: result.measurement_observed,
    experiment_completed: result.experiment_completed,
    outcome: result.outcome,
    questions_supported: result.questions_supported,
    failure_reasons: result.failure_reasons,
  })}\n`);
  if (!result.success) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeErrorKind(error, 'invalid_arguments') })}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  JSON_RPC_METHODS,
  NativeQuestionError,
  buildQuestionArguments: require('./native-fixture').buildQuestionArguments,
  bindQuestionTurn,
  classifyServerMethod,
  classifyQuestionOutcome,
  createQuestionRpcLedger,
  fixedAnswerPayload,
  parseArguments,
  projectQuestionRequest,
  questionFlowSucceeded,
  removeRuntimeHome,
  runNativeProbe,
  safeErrorKind,
  summarizeRpcLedger,
};
