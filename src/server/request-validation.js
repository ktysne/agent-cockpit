const { isRequestSessionId } = require('./session-ids');

const MAX_EXTERNAL_URL_LENGTH = 2048;

// 起動するプログラムには検査した値そのものを渡すため、正規化した href を返す。
// rundll32 は引数を ShellExecute へそのまま渡すので、空白や引用符が残る値は受けない。
function normalizeExternalUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_EXTERNAL_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.href.length > MAX_EXTERNAL_URL_LENGTH || /[\s"]/.test(url.href)) return null;
    return url.protocol === 'https:' ? url.href : null;
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
      (task.criteria !== undefined && (!Array.isArray(task.criteria) || task.criteria.length > 20 || !task.criteria.every((criterion) => (
        criterion && typeof criterion === 'object' && !Array.isArray(criterion) &&
        validText(criterion.text, 2000) && typeof criterion.met === 'boolean' &&
        (criterion.doing === undefined || typeof criterion.doing === 'boolean')
      ))))
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
      (option.next !== undefined && !validText(option.next, 2000, true)) ||
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
      ['waiting', 'provisional'].includes(body.state) && validDecisionOptions(body.options) &&
      (body.verify === undefined || validVerify(body.verify));
  }
  if (body.kind === 'report_launch') return validText(body.id, 256) && validLaunchTarget(body) &&
    Object.keys(body).every(key => ['kind', 'id', 'url', 'process', 'ppid', 'claudeCodeSessionId', 'codexSessionId'].includes(key));
  if (body.kind === 'update_decision') {
    return validText(body.id, 256) && ['provisional', 'resolved'].includes(body.state) &&
      validChosen(body.chosen) && validText(body.note, 2000, true);
  }
  return false;
}

function validLaunchTarget(value) {
  const hasUrl = Object.hasOwn(value, 'url');
  const hasProcess = Object.hasOwn(value, 'process');
  if (hasUrl === hasProcess) return false;
  if (hasProcess) return validText(value.process, 500);
  if (!validText(value.url, 2048) || /[\u0000-\u0020\u007f]/.test(value.url)) return false;
  try { return ['http:', 'https:'].includes(new URL(value.url).protocol); } catch { return false; }
}

function validVerify(value, stored = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = stored ? ['steps', 'launched'] : ['steps'];
  return Object.keys(value).every(key => keys.includes(key)) && Array.isArray(value.steps) &&
    value.steps.length >= 1 && value.steps.length <= 10 && value.steps.every(step =>
      step && typeof step === 'object' && !Array.isArray(step) &&
      Object.keys(step).every(key => ['cmd', 'note'].includes(key)) &&
      validText(step.cmd, 500) && validText(step.note, 500, true)) &&
    (value.launched === undefined || (stored && validLaunchTarget(value.launched) &&
      Object.keys(value.launched).every(key => ['url', 'process', 'at'].includes(key)) &&
      typeof value.launched.at === 'string' && Number.isFinite(Date.parse(value.launched.at))));
}

function decisionSummaries(state, sessionId) {
  return state.decisionsFor(sessionId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map(({ id, title, state: decisionState }) => ({ id, title, state: decisionState }));
}

module.exports = {
  normalizeExternalUrl,
  validSessionId,
  validText,
  validTasks,
  validSeenRequest,
  validDecisionOptions,
  validChosen,
  validPlanInput,
  validVerify,
  validLaunchTarget,
  decisionSummaries,
};
