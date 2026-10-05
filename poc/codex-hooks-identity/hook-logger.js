'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PreCompact', 'PostCompact', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop',
  'Stop', 'Interrupt',
]);
const SESSION_SOURCES = new Set(['startup', 'resume', 'clear', 'compact']);
const TRIGGERS = new Set(['manual', 'auto']);
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']);
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const CREDENTIAL_PREFIX = /^(?:sk-|gh[pousr]_|github_pat_|bearer\s|eyJ)/i;

function allowedString(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : 'unknown';
}

function identifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && !CREDENTIAL_PREFIX.test(value) ? value : 'unknown';
}

function shortString(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && !CREDENTIAL_PREFIX.test(value) ? value : 'unknown';
}

function buildHookRecord(input, timestamp = new Date().toISOString()) {
  const eventName = allowedString(input && input.hook_event_name, EVENTS);
  const record = {
    recorded_at: timestamp,
    hook_event_name: eventName,
    session_id: identifier(input && input.session_id),
    agent_id: identifier(input && input.agent_id),
    agent_type: shortString(input && input.agent_type),
    model: shortString(input && input.model),
    turn_id: identifier(input && input.turn_id),
    source: allowedString(input && input.source, SESSION_SOURCES),
    reason: input && input.reason === 'other' ? 'other' : 'unknown',
    trigger: allowedString(input && input.trigger, TRIGGERS),
    tool_name: shortString(input && input.tool_name),
    tool_use_id: identifier(input && input.tool_use_id),
    permission_mode: allowedString(input && input.permission_mode, PERMISSION_MODES),
    stop_hook_active: typeof (input && input.stop_hook_active) === 'boolean'
      ? input.stop_hook_active
      : 'unknown',
  };

  if (eventName === 'PostToolUse') record.tool_outcome = 'unknown';
  return record;
}

async function appendHookRecord(input, directory, timestamp) {
  const record = buildHookRecord(input, timestamp);
  const filePath = path.join(directory, 'events.jsonl');
  try {
    const stat = await fs.promises.lstat(filePath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) return false;
    await fs.promises.appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function readHookInput(stream) {
  return new Promise(resolve => {
    let content = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => { content += chunk; });
    stream.on('end', () => {
      try {
        const value = JSON.parse(content);
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : null);
      } catch {
        resolve(null);
      }
    });
    stream.on('error', () => resolve(null));
  });
}

async function runHookLogger(input, directory, stdout = process.stdout) {
  if (input) await appendHookRecord(input, directory);
  if (input && ['Stop', 'SubagentStop'].includes(input.hook_event_name)) stdout.write('{}\n');
}

if (require.main === module) {
  readHookInput(process.stdin).then(input => runHookLogger(input, __dirname));
}

module.exports = { appendHookRecord, buildHookRecord, readHookInput, runHookLogger };
