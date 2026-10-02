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
]);

const MAX_ASK_QUESTIONS = 4;
const MAX_ASK_OPTIONS = 6;
const QUESTION_TEXT_LIMIT = 2000;

function boundedString(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
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
        recommended: label.startsWith('(推奨)'),
      }];
    }) : [];
    const text = boundedString(question.question, QUESTION_TEXT_LIMIT);
    if (!text) return [];
    return [{
      question: text,
      header: boundedString(question.header, 200),
      multiSelect: question.multiSelect === true,
      options,
    }];
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

  const agentId = shortString(input.agent_id, 256);
  const agentType = shortString(input.agent_type, 200);
  if (agentId) event.agent_id = agentId;
  if (agentType) event.agent_type = agentType;

  if (eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
    event.tool_name = shortString(input.tool_name, 100) || '';
    event.tool_use_id = shortString(input.tool_use_id, 256) || '';
  }

  if (eventName === 'PreToolUse') {
    event.summary = shortString(input.summary, 80) || event.tool_name;
    event.codexDefinition = parseCodexLaunch(event.summary);
    if (metadata.agentDefinition) event.agentDefinition = metadata.agentDefinition;
    if (event.tool_name === 'Agent') event.description = shortString(input.description, 200) || '';
    if (event.tool_name === 'AskUserQuestion' && !agentId) {
      event.questions = sanitizeQuestions(input.questions);
    }
  }

  if (eventName === 'PostToolUse') {
    if (event.tool_name === 'AskUserQuestion' && !agentId) {
      event.decisionResolution = sanitizeDecisionResolution(input.decisionResolution) || { chosen: [], note: '' };
    }
    if (event.tool_name === 'Agent') {
      event.resolvedModel = shortString(input.resolvedModel, 160) || '';
    }
  }

  if ((eventName === 'PostToolUse' || eventName === 'PostToolUseFailure')
    && input.codexOutput && typeof input.codexOutput === 'object' && !Array.isArray(input.codexOutput)) {
    const audit = parseCodexAuditLine(input.codexOutput.auditLine);
    const result = parseCodexResultLine(input.codexOutput.resultLine);
    if (audit) event.codexAudit = audit;
    if (result) event.codexResult = result;
  }

  if (eventName === 'Notification') {
    event.notification_type = shortString(input.notification_type, 100) || '';
    event.message = shortString(input.message, 200) || '';
  }

  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
    if (metadata.agentDefinition) event.agentDefinition = metadata.agentDefinition;
  }

  return event;
}

module.exports = {
  EVENT_NAMES,
  MAX_ASK_QUESTIONS,
  MAX_ASK_OPTIONS,
  QUESTION_TEXT_LIMIT,
  parseCodexLaunch,
  sanitizeQuestions,
  sanitizeDecisionResolution,
  parseCodexAuditLine,
  parseCodexResultLine,
  sanitizeEvent,
};
