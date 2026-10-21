const { TOOL_NAMES } = require('./mcp-tool-names');

function integrationManifest(root) {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const hook = (provider, name, properties = {}, matcher) => ({
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: 'command', command: provider === 'codex' ? `node "${base}/src/hooks/${name}.js" codex` : 'node',
      ...(provider === 'claude' ? { args: [`${base}/src/hooks/${name}.js`] } : {}), ...properties }],
  });
  const claude = (name, properties, matcher) => hook('claude', name, properties, matcher);
  const codex = (name, properties, matcher) => hook('codex', name, properties, matcher);
  const claudeHooks = {
    SessionStart: [claude('event'), claude('away', { timeout: 5 })],
    PreToolUse: [claude('event', { async: true }, ''), claude('away', { timeout: 1830 }, 'AskUserQuestion|mcp__ccd_turn__wrap_up')],
    PostToolUse: [claude('event', { async: true }, '')],
    PostToolUseFailure: [claude('event', { async: true }, '')],
    PostToolBatch: [claude('answer', { timeout: 2 })],
    Notification: [claude('event', { async: true })],
    SubagentStart: [claude('event', { async: true })],
    SubagentStop: [claude('event', { async: true })],
    Stop: [claude('event', { async: true }), claude('answer', { asyncRewake: true, timeout: 3600 })],
    SessionEnd: [claude('event', { async: true })],
    UserPromptSubmit: [claude('event', { async: true }), claude('away', { timeout: 5 }), claude('answer', { timeout: 5 })],
  };
  const claudeRouteHooks = {
    SubagentStart: [claude('route', { timeout: 5 }, '')],
    PreToolUse: [claude('route', { timeout: 5 }, 'Bash|PowerShell')],
  };
  const codexHooks = {
    SessionStart: [codex('event'), codex('away', { timeout: 5 })],
    UserPromptSubmit: [codex('event'), codex('away', { timeout: 5 }), codex('answer', { timeout: 5 })],
    PreToolUse: [codex('event'), codex('away', { timeout: 1830 }, 'request_user_input_async|request_user_input')],
    PermissionRequest: [codex('event')],
    PostToolUse: [codex('event'), codex('answer', { timeout: 5 })],
    Stop: [codex('event'), codex('answer', { timeout: 3600 })],
    Interrupt: [codex('event')],
    SessionEnd: [codex('event')],
    SubagentStart: [codex('event')],
    SubagentStop: [codex('event')],
  };
  const mcp = { command: 'node', args: [`${base}/src/mcp/server.js`] };
  return {
    claude: { hooks: claudeHooks, routeHooks: claudeRouteHooks, mcp, skills: {
      'skills/agent-cockpit/SKILL.md': 'skills/agent-cockpit/SKILL.md',
      'skills/update-tools/SKILL.md': 'skills/update-tools/SKILL.md',
    } },
    codex: { hooks: codexHooks, mcp: { ...mcp, tools: Object.fromEntries(TOOL_NAMES.map(name => [name, { approval_mode: 'approve' }])) },
      skills: {
        'skills/codex/agent-cockpit/SKILL.md': 'skills/agent-cockpit/SKILL.md',
        'skills/update-tools/SKILL.md': 'skills/update-tools/SKILL.md',
      } },
  };
}

module.exports = { integrationManifest };
