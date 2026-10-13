const MAX_DIAGNOSTICS_PER_EVENT = 8;
const MAX_DIAGNOSTICS_BODY_BYTES = 16 * 1024;
const TOOL_NAMES = ['cockpit_set_tasks', 'cockpit_add_decision', 'cockpit_update_decision', 'cockpit_add_pr', 'cockpit_skip_review'];
const CLIENT_EVENTS = Object.freeze({
  'hook.input': { tag: 'hook', level: 'info', fields: { result: ['parsed', 'invalid'] } },
  'hook.pid': { tag: 'hook', level: 'info', fields: { result: ['found', 'missing', 'timeout', 'failed'], durationMs: 'number' } },
  'hook.server': { tag: 'hook', level: 'info', fields: { started: 'boolean' } },
  // 退避した行は常駐サーバーの次の起動まで取り込まれないことがあるため、発生時刻を持たせる。
  'hook.delivery': { tag: 'hook', level: 'warn', fields: { failure: ['unreachable', 'timeout'], at: 'timestamp' } },
  'mcp.write': { tag: 'mcp', level: 'info', fields: { tool: TOOL_NAMES, phase: ['attempt', 'result'], ok: 'boolean', failure: ['http', 'timeout', 'unreachable'], status: 'status' } },
  'web.failed': { tag: 'web', level: 'warn', fields: { operation: ['fetch', 'save'], path: 'path', status: 'status' } },
});
const WEB_PATHS = ['/', '/api/state', '/api/diagnostics', '/api/diagnostics/delete', '/api/open-url', '/api/away', '/api/routing', '/api/display', '/api/record-deletions', '/api/hidden-sessions', '/api/seen', '/api/closed-tasks', '/api/closed-agents', '/api/pull-requests/review-skip', '/api/pull-requests/merge', '/api/pull-requests/reserve', '/api/pull-requests/cancel-reservation', '/api/pull-requests/conflict-request', '/api/pull-requests/merge-result/close', '/api/pull-requests/repository/unregister', '/api/sessions/:id/estimate', '/api/decisions/:id/answer', '/api/sessions/:id/context'];

function sanitizeClientEntry(entry, tag) {
  if (!entry || typeof entry.msg !== 'string' || !Object.hasOwn(CLIENT_EVENTS, entry.msg)) return null;
  const spec = CLIENT_EVENTS[entry.msg];
  if (spec.tag !== tag) return null;
  const data = {};
  for (const [key, kind] of Object.entries(spec.fields)) {
    const value = entry.data?.[key];
    if (Array.isArray(kind) ? kind.includes(value)
      : kind === 'number' ? Number.isFinite(value) && value >= 0
      : kind === 'boolean' ? typeof value === 'boolean'
      : kind === 'status' ? Number.isInteger(value) && value >= 100 && value <= 599
      : kind === 'timestamp' ? typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      : WEB_PATHS.includes(value)) data[key] = value;
  }
  return { msg: entry.msg, data };
}

function clientEntryLevel(clean) {
  return clean.msg === 'mcp.write' && clean.data.ok === false ? 'error'
    : ['hook.input', 'hook.pid'].includes(clean.msg) && ['invalid', 'failed', 'timeout'].includes(clean.data.result) ? 'warn'
    : CLIENT_EVENTS[clean.msg].level;
}

function recordClientEntries(diagnostics, entries, tag) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries.slice(0, MAX_DIAGNOSTICS_PER_EVENT)) {
    const clean = sanitizeClientEntry(entry, tag);
    if (!clean) continue;
    diagnostics?.record(clientEntryLevel(clean), tag, clean.msg, clean.data);
  }
}

module.exports = { CLIENT_EVENTS, MAX_DIAGNOSTICS_PER_EVENT, MAX_DIAGNOSTICS_BODY_BYTES, sanitizeClientEntry, clientEntryLevel, recordClientEntries };
