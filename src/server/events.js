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

function shortString(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

function parseCodexLaunch(summary) {
  if (typeof summary !== 'string') return null;
  const match = summary.match(/(?:^|[\\/\s])codex-agent(?:\.sh|\.cmd|\.ps1)?\s+['"]?([A-Za-z0-9_.-]+)/i);
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
  }

  if (eventName === 'PostToolUse') {
    if (event.tool_name === 'Agent') {
      event.resolvedModel = shortString(input.resolvedModel, 160) || '';
    }
    if (event.tool_name === 'Bash' && input.codexAudit && typeof input.codexAudit === 'object') {
      const audit = input.codexAudit;
      if (typeof audit.agent_id === 'string') {
        event.codexAudit = {
          agent_id: audit.agent_id.slice(0, 256),
          model: shortString(audit.model, 160) || '',
          effort: shortString(audit.effort, 80) || '',
        };
      }
    }
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

module.exports = { EVENT_NAMES, parseCodexLaunch, sanitizeEvent };
