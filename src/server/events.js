const { parsePullRequestUrl } = require('./pull-request-utils');

const EVENT_NAMES = new Set([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
  'UserPromptSubmit',
  'PostToolBatch',
]);

const MAX_ASK_QUESTIONS = 4;
const MAX_ASK_OPTIONS = 6;
const QUESTION_TEXT_LIMIT = 2000;
const CODEX_RUN_ID_PATTERN = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)-\d{8}-\d{6}-\d+$/;
const CODEX_REVIEW_DEFINITIONS = new Set(['codex-review', 'codex-subagent']);

function boundedString(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function recommendedOptionFor(question) {
  if (!question || question.multiSelect || !Array.isArray(question.options)) return null;
  const matches = question.options.filter((option) => (
    option.recommended === true || /(?:\(推奨\)|（推奨）|\(recommended\)|（recommended）)/i.test(option.label)
  ));
  return matches.length === 1 ? matches[0] : null;
}

function sanitizeQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ASK_QUESTIONS).flatMap((question) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) return [];
    const options = Array.isArray(question.options) ? question.options.slice(0, MAX_ASK_OPTIONS).flatMap((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return [];
      const label = boundedString(option.label, 200);
      if (!label) return [];
      return [{
        label,
        description: boundedString(option.description, QUESTION_TEXT_LIMIT),
        recommended: false,
      }];
    }) : [];
    const text = boundedString(question.question, QUESTION_TEXT_LIMIT);
    if (!text) return [];
    const sanitized = {
      question: text,
      header: boundedString(question.header, 200),
      multiSelect: question.multiSelect === true,
      options,
    };
    const recommended = recommendedOptionFor(sanitized);
    if (recommended) recommended.recommended = true;
    return [sanitized];
  });
}

function sanitizeDecisionResolution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const chosen = Array.isArray(value.chosen)
    ? value.chosen.slice(0, MAX_ASK_OPTIONS).map((item) => boundedString(item, QUESTION_TEXT_LIMIT)).filter(Boolean)
    : boundedString(value.chosen, QUESTION_TEXT_LIMIT);
  return {
    chosen,
    note: boundedString(value.note, QUESTION_TEXT_LIMIT),
  };
}

function shortString(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

function parseCodexAuditLine(value) {
  if (typeof value !== 'string') return null;
  const line = value.slice(0, 1024).trim();
  const match = line.match(/^codex-agent:\s*agent=[^\s]+\s+model=([^\s]+)\s+effort=([^\s]+)(?:\s|$)/);
  if (!match) return null;
  const codexHome = line.match(/(?:^|\s)codex_home=(.*?)(?=\s+workdir=|$)/)?.[1]?.trim() || '';
  return { model: match[1].slice(0, 160), effort: match[2].slice(0, 80), codex_home: codexHome.slice(0, 512) };
}

function parseCodexResultLine(value) {
  if (typeof value !== 'string') return null;
  const match = value.slice(0, 1024).trim().match(/^codex-agent:\s*result=(ok|rate-limited|unavailable|failed)(?:\s+exit=(\d+))?(?:\s|$)/);
  if (!match) return null;
  return { status: match[1], exitCode: match[2] ? Number(match[2]) : null };
}

function parseCodexRunLine(value) {
  if (typeof value !== 'string') return null;
  const match = value.slice(0, 1024).trim().match(/^codex-agent:\s*run=([^\s]+)(?:\s|$)/);
  return match && CODEX_RUN_ID_PATTERN.test(match[1]) ? match[1] : null;
}

// 定義の名前は英数字か _ で始まる。--wait などのオプションは起動ではなく、背景の実行の結果を取り出す呼び出しである。
function parseCodexLaunch(summary) {
  if (typeof summary !== 'string') return null;
  const match = summary.match(/(?:^|[\\/\s])codex-agent(?:\.sh|\.cmd|\.ps1)?\s+['"]?([A-Za-z0-9_][A-Za-z0-9_.-]*)/i);
  return match ? match[1] : null;
}

function sanitizeEvent(input, metadata = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const sessionId = shortString(input.session_id, 256);
  const eventName = input.hook_event_name;
  if (!sessionId || !EVENT_NAMES.has(eventName)) return null;

  const hookAt = Number.isFinite(Number(input.hookAt)) ? Number(input.hookAt) : Date.now();
  const event = {
    session_id: sessionId,
    hook_event_name: eventName,
    hookAt,
    product: metadata.product || null,
    sessionName: shortString(metadata.sessionName, 200) || null,
  };

  if (eventName === 'SessionStart') event.source = shortString(input.source, 100) || '';

  const agentId = shortString(input.agent_id, 256);
  const agentType = shortString(input.agent_type, 200);
  if (agentId) event.agent_id = agentId;
  if (agentType) event.agent_type = agentType;
  if (eventName === 'SubagentStart' && ['default', 'codex', 'claude'].includes(input.route)) event.route = input.route;
  if (metadata.agentDefinition) event.agentDefinition = metadata.agentDefinition;

  if (eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
    event.tool_name = shortString(input.tool_name, 100) || '';
    event.tool_use_id = shortString(input.tool_use_id, 256) || '';
  }

  if (eventName === 'PreToolUse') {
    event.summary = shortString(input.summary, 80) || event.tool_name;
    event.codexDefinition = parseCodexLaunch(event.summary);
    if (event.tool_name === 'Bash' && !event.codexDefinition && CODEX_REVIEW_DEFINITIONS.has(input.codexReviewDefinition)) {
      event.codexDefinition = input.codexReviewDefinition;
    }
    const codexWaitRunId = shortString(input.codexWaitRunId, 256) || '';
    const codexWaitMatch = codexWaitRunId.match(CODEX_RUN_ID_PATTERN);
    if (event.tool_name === 'Bash' && !event.codexDefinition && codexWaitMatch) {
      event.codexWaitRunId = codexWaitRunId;
      event.codexWaitDefinition = codexWaitRunId.replace(/-\d{8}-\d{6}-\d+$/, '');
    }
    if (metadata.codexAgentDefinition) event.codexAgentDefinition = metadata.codexAgentDefinition;
    if (event.tool_name === 'Agent') event.description = shortString(input.description, 200) || '';
    if (input.ghPrCreateCommand === true) event.ghPrCreateCommand = true;
    if (input.refreshPullRequestsCommand === true) event.refreshPullRequestsCommand = true;
    if (event.tool_name === 'AskUserQuestion' && !agentId) {
      event.questions = sanitizeQuestions(input.questions);
    }
  }

  if (eventName === 'PostToolUse') {
    if (event.tool_name === 'TaskStop' && typeof input.stoppedTaskId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.stoppedTaskId)) {
      event.stoppedTaskId = input.stoppedTaskId;
    }
    if (event.tool_name === 'AskUserQuestion' && !agentId) {
      event.decisionResolution = sanitizeDecisionResolution(input.decisionResolution) || { chosen: [], note: '' };
    }
    if (event.tool_name === 'Agent') {
      event.resolvedModel = shortString(input.resolvedModel, 160) || '';
    }
  }

  if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
    if (input.ghPrCreateCommand === true) event.ghPrCreateCommand = true;
    if (input.refreshPullRequests === true) event.refreshPullRequests = true;
    for (const key of ['backgroundTaskId', 'backgroundOutputTaskId']) {
      if (typeof input[key] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input[key])) event[key] = input[key];
    }
  }
  if (eventName === 'PostToolUse') {
    const pullRequest = parsePullRequestUrl(input.pullRequest?.url);
    if (pullRequest && input.pullRequest.owner === pullRequest.owner && input.pullRequest.repo === pullRequest.repo &&
      input.pullRequest.number === pullRequest.number) event.pullRequest = pullRequest;
  }

  if ((eventName === 'PostToolUse' || eventName === 'PostToolUseFailure')
    && input.codexOutput && typeof input.codexOutput === 'object' && !Array.isArray(input.codexOutput)) {
    const audit = parseCodexAuditLine(input.codexOutput.auditLine);
    const result = parseCodexResultLine(input.codexOutput.resultLine);
    const runId = parseCodexRunLine(input.codexOutput.runLine);
    if (audit) event.codexAudit = audit;
    if (result) event.codexResult = result;
    if (runId) event.codexRunId = runId;
    const waitStatus = typeof input.codexOutput.waitStatusLine === 'string'
      && input.codexOutput.waitStatusLine.slice(0, 1024).trim().match(/^codex-agent:\s*(waiting|vanished|orphaned|unverified|not-found)\s+run=/);
    if (waitStatus) event.codexWaitStatus = waitStatus[1];
  }

  if (eventName === 'Notification') {
    event.notification_type = shortString(input.notification_type, 100) || '';
    event.message = shortString(input.message, 200) || '';
  }

  return event;
}

module.exports = {
  EVENT_NAMES,
  MAX_ASK_QUESTIONS,
  recommendedOptionFor,
  MAX_ASK_OPTIONS,
  QUESTION_TEXT_LIMIT,
  parseCodexLaunch,
  sanitizeQuestions,
  sanitizeDecisionResolution,
  parseCodexAuditLine,
  parseCodexResultLine,
  sanitizeEvent,
};
