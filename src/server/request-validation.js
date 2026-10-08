const { isRequestSessionId } = require('./session-ids');
const { OWNED_PROCESS_STATES, MAX_EXTERNAL_URL_LENGTH, MAX_NATIVE_PENDING_REQUESTS } = require('./server-constants');

// 起動するプログラムには検査した値そのものを渡すため、正規化した href を返す。
// rundll32 は引数を ShellExecute へそのまま渡すので、空白や引用符が残る値は受けない。
function normalizeExternalUrl(value, port) {
  if (typeof value !== 'string' || value.length > MAX_EXTERNAL_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.href.length > MAX_EXTERNAL_URL_LENGTH || /[\s"]/.test(url.href)) return null;
    if (url.protocol === 'https:') return url.href;

    const urlPort = Number(url.port || 80);
    const matchesLocalhost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    const isManualPath = url.pathname.startsWith('/manual/');
    if (url.protocol !== 'http:' || !matchesLocalhost || urlPort !== port || !isManualPath || url.username || url.password) return null;

    const normalizedUrl = `http://127.0.0.1:${port}${url.pathname}${url.search}${url.hash}`;
    if (normalizedUrl.length > MAX_EXTERNAL_URL_LENGTH || /[\s"]/.test(normalizedUrl)) return null;
    return normalizedUrl;
  } catch {
    return null;
  }
}

function validSessionId(value) {
  return isRequestSessionId(value);
}

function validText(value, maxLength, allowEmpty = false) {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.trim().length > 0);
}

function validTasks(value) {
  if (!Array.isArray(value) || value.length > 50) return false;
  const titles = new Set();
  for (const task of value) {
    if (
      !task || typeof task !== 'object' || Array.isArray(task) ||
      !validText(task.title, 200) || titles.has(task.title) || !['todo', 'doing', 'done'].includes(task.state) ||
      !Array.isArray(task.criteria) || task.criteria.length > 20 || !task.criteria.every((criterion) => (
        criterion && typeof criterion === 'object' && !Array.isArray(criterion) &&
        validText(criterion.text, 2000) && typeof criterion.met === 'boolean'
      ))
    ) return false;
    titles.add(task.title);
  }
  return true;
}

function validSeenRequest(value) {
  const generatedAt = Date.parse(value?.generatedAt || '');
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Object.hasOwn(value, 'productKey') && Object.hasOwn(value, 'generatedAt') &&
    typeof value.productKey === 'string' && value.productKey.trim().length > 0 && value.productKey.length <= 500 &&
    typeof value.generatedAt === 'string' && Number.isFinite(generatedAt) && generatedAt <= Date.now();
}

function validDecisionOptions(value) {
  if (!Array.isArray(value) || value.length > 6) return false;
  let recommendedCount = 0;
  for (const option of value) {
    if (
      !option || typeof option !== 'object' || Array.isArray(option) ||
      !validText(option.label, 200) || !validText(option.description, 2000, true) ||
      (option.recommended !== undefined && typeof option.recommended !== 'boolean')
    ) return false;
    if (option.recommended) recommendedCount += 1;
  }
  return recommendedCount <= 1;
}

function validChosen(value) {
  if (typeof value === 'string') return value.length <= 2000;
  return Array.isArray(value) && value.length <= 6 && value.every((item) => validText(item, 2000, true));
}

function validPlanInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.kind === 'tasks') return validTasks(body.tasks);
  if (body.kind === 'add_decision') {
    return validText(body.title, 200) && validText(body.context, 2000, true) &&
      ['waiting', 'provisional'].includes(body.state) && validDecisionOptions(body.options);
  }
  if (body.kind === 'update_decision') {
    return validText(body.id, 256) && ['provisional', 'resolved'].includes(body.state) &&
      validChosen(body.chosen) && validText(body.note, 2000, true);
  }
  return false;
}

function hasOnlyKeys(value, fields) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)) &&
    Object.keys(value).every((field) => fields.includes(field));
}

function hasExactKeys(value, fields) {
  return hasOnlyKeys(value, fields) && Object.keys(value).length === fields.length;
}

function sameQuestionIdentity(left, right) {
  const fields = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
  return hasExactKeys(left, fields) && hasExactKeys(right, fields) &&
    fields.every((field) => left[field] === right[field]);
}

function questionErrorStatus(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code.startsWith('invalid_') || code === 'question_category_forbidden') return 400;
  if (['question_writer_unverified', 'question_writer_binding_mismatch'].includes(code)) return 403;
  if (code === 'question_not_found') return 404;
  if (['question_conflict', 'question_cancelled', 'question_delivery_mismatch', 'question_delivery_digest_mismatch'].includes(code)) return 409;
  return 503;
}

const INSTRUCTION_MODES = new Set(['steer', 'start', 'next-user-input']);
const INSTRUCTION_STATES = new Set(['available', 'claimed', 'sending', 'accepted', 'applied', 'unknown', 'unavailable', 'cancelled_before_send', 'superseded_before_send']);

function validScopedIdentifier(value, maxLength = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function validInstructionIdentity(value) {
  const fields = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
  return hasExactKeys(value, fields) && ['claude', 'codex'].includes(value.provider) &&
    fields.slice(1).every((field) => validScopedIdentifier(value[field]));
}

function instructionProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !validScopedIdentifier(value.deliveryAttemptId) || !validScopedIdentifier(value.logicalMessageId) ||
      !validScopedIdentifier(value.launchRef) || !validSessionId(value.sessionId) ||
      !validScopedIdentifier(value.executionId) || !validInstructionIdentity(value.identity) ||
      !['standalone', 'delegated', 'review'].includes(value.origin) || !INSTRUCTION_STATES.has(value.state) ||
      !INSTRUCTION_MODES.has(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      (value.nativeTurnId !== null && !validScopedIdentifier(value.nativeTurnId)) ||
      (value.heldReason !== null && value.heldReason !== undefined && !validText(value.heldReason, 512, true)) ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) return null;
  return {
    deliveryAttemptId: value.deliveryAttemptId,
    logicalMessageId: value.logicalMessageId,
    revision: value.revision,
    launchRef: value.launchRef,
    sessionId: value.sessionId,
    executionId: value.executionId,
    identity: { ...value.identity },
    origin: value.origin,
    state: value.state,
    mode: value.mode,
    nativeTurnId: value.nativeTurnId,
    heldReason: value.heldReason ?? null,
    createdAt: value.createdAt ?? null,
  };
}

function ownedExecutionProjection(value) {
  const fields = ['launchRef', 'executionId', 'sessionId', 'expectedContextId', 'expectedOwnerGeneration',
    'stopRevision', 'processState', 'canStop', 'stopConfirmed', 'hold'];
  if (!hasExactKeys(value, fields) || !validScopedIdentifier(value.launchRef) ||
      !validScopedIdentifier(value.executionId) || !validSessionId(value.sessionId) ||
      (value.expectedContextId !== null && !validScopedIdentifier(value.expectedContextId)) ||
      !Number.isSafeInteger(value.expectedOwnerGeneration) || value.expectedOwnerGeneration < 0 ||
      !Number.isSafeInteger(value.stopRevision) || value.stopRevision < 0 ||
      !OWNED_PROCESS_STATES.has(value.processState) || typeof value.canStop !== 'boolean' ||
      typeof value.stopConfirmed !== 'boolean' || value.stopConfirmed && value.processState !== 'stopped' ||
      value.stopConfirmed && value.canStop) return null;
  const hold = value.hold;
  if (!hasExactKeys(hold, ['reason', 'retainedRequestCount', 'remainingRequestCount', 'limit']) ||
      ![null, 'capacity', 'unknown'].includes(hold.reason) || hold.limit !== MAX_NATIVE_PENDING_REQUESTS ||
      !Number.isSafeInteger(hold.retainedRequestCount) || hold.retainedRequestCount < 0 ||
      hold.retainedRequestCount > hold.limit || !Number.isSafeInteger(hold.remainingRequestCount) ||
      hold.remainingRequestCount < 0 || hold.remainingRequestCount > hold.limit ||
      hold.retainedRequestCount + hold.remainingRequestCount !== hold.limit ||
      hold.reason === 'capacity' && (hold.retainedRequestCount !== hold.limit || hold.remainingRequestCount !== 0)) return null;
  return {
    launchRef: value.launchRef,
    executionId: value.executionId,
    sessionId: value.sessionId,
    expectedContextId: value.expectedContextId,
    expectedOwnerGeneration: value.expectedOwnerGeneration,
    stopRevision: value.stopRevision,
    processState: value.processState,
    canStop: value.canStop,
    stopConfirmed: value.stopConfirmed,
    hold: { ...hold },
  };
}

function instructionErrorStatus(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'instruction_not_found' || code === 'delivery_not_found') return 404;
  if (['instruction_scope_mismatch', 'instruction_launch_unavailable'].includes(code)) return 403;
  if (code.startsWith('invalid_') || code.startsWith('expected_turn_') ||
      code.startsWith('instruction_invalid_') || code.startsWith('instruction_expected_turn_') ||
      code === 'unexpected_turn' || code === 'instruction_envelope_too_large') return 400;
  if (['instruction_not_sendable', 'instruction_not_supersedable', 'instruction_mode_requires_supersede'].includes(code) ||
      code.includes('conflict') || code.includes('mismatch') || code.includes('unavailable') ||
      code.includes('unverified') || code.includes('forbidden') || code.includes('unsupported') ||
      code.includes('timeout') || code.includes('requires_supersede')) return 409;
  return 503;
}

function decisionSummaries(state, sessionId) {
  return state.decisionsFor(sessionId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map(({ id, title, state: decisionState }) => ({ id, title, state: decisionState }));
}

module.exports = { normalizeExternalUrl, validSessionId, validText, validTasks, validSeenRequest, validDecisionOptions, validChosen, validPlanInput, hasOnlyKeys, hasExactKeys, sameQuestionIdentity, questionErrorStatus, INSTRUCTION_MODES, INSTRUCTION_STATES, validScopedIdentifier, validInstructionIdentity, instructionProjection, ownedExecutionProjection, instructionErrorStatus, decisionSummaries };
