'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { REPOSITORY_ROOT, assertNoSymlinkComponents, resolveOutputDirectory } = require('../codex-hooks-identity/setup');

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_HOOK_FILE_BYTES = 64 * 1024;
const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_PREFIX = /^(?:sk-|gh[pousr]_|github_pat_|bearer\s|eyJ)/i;
const NONCE = /^[a-f0-9]{64}$/i;
const HOOK_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PreCompact', 'PostCompact', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop',
  'Stop', 'Interrupt',
]);
const EVENT_FIELDS = ['hook_event_name', 'session_id', 'agent_id', 'agent_type'];
const TOOL_NAME = 'probe_identity';

function safeIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && !CREDENTIAL_PREFIX.test(value)
    ? value
    : null;
}

function nonceMatches(environment = process.env) {
  const actual = environment.POC159_NONCE;
  const expected = environment.POC159_EXPECTED_NONCE;
  if (typeof actual !== 'string' || typeof expected !== 'string' || !NONCE.test(actual) || !NONCE.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function projectRegistration(environment = process.env) {
  return {
    run_id: safeIdentifier(environment.POC159_RUN_ID),
    attempt_id: safeIdentifier(environment.POC159_ATTEMPT_ID),
    nonce_match: nonceMatches(environment),
  };
}

function buildIdentityProbe(_args = {}, environment = process.env, meta = {}) {
  return {
    registration: projectRegistration(environment),
    inherited_session: projectInheritedSession(environment),
    mcp_meta: {
      thread_id: safeIdentifier(meta.threadId),
    },
  };
}

function projectInheritedSession(environment = process.env) {
  const sessionId = environment.CLAUDE_CODE_SESSION_ID;
  const expectedSessionId = environment.POC159_EXPECTED_CLAUDE_SESSION_ID;
  const present = typeof sessionId === 'string' && sessionId.length > 0;
  const expectedPresent = typeof expectedSessionId === 'string' && expectedSessionId.length > 0;
  return {
    present,
    matches_expected: present && expectedPresent ? sessionId === expectedSessionId : null,
  };
}

function buildHookRecord(input, environment = process.env) {
  const eventName = input && input.hook_event_name;
  return {
    event: typeof eventName === 'string' && HOOK_EVENTS.has(eventName) ? eventName : 'unknown',
    session_id: safeIdentifier(input && input.session_id),
    agent_id: safeIdentifier(input && input.agent_id),
    agent_type: safeIdentifier(input && input.agent_type),
    run_id: safeIdentifier(environment.POC159_RUN_ID),
    attempt_id: safeIdentifier(environment.POC159_ATTEMPT_ID),
    claude_session_present: projectInheritedSession(environment).present,
    claude_session_matches_expected: projectInheritedSession(environment).matches_expected,
  };
}

function validateCapturePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) {
    throw new Error('Hook capture path is invalid');
  }
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  resolveOutputDirectory(directory, REPOSITORY_ROOT);
  assertNoSymlinkComponents(REPOSITORY_ROOT, directory);
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Hook capture directory is invalid');
  try {
    const fileStat = fs.lstatSync(resolved);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('Hook capture file is invalid');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resolved;
}

function appendHookRecord(input, filePath, environment = process.env) {
  const outputPath = validateCapturePath(filePath);
  const line = Buffer.from(`${JSON.stringify(buildHookRecord(input, environment))}\n`, 'utf8');
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(outputPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow, 0o600);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size + line.length > MAX_HOOK_FILE_BYTES) return false;
    fs.writeSync(descriptor, line);
    return true;
  } finally {
    fs.closeSync(descriptor);
  }
}

function makeResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleMcpRequest(request, environment = process.env) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return request && Object.hasOwn(request, 'id') ? makeError(request.id, -32600, 'Invalid request') : null;
  }
  const hasId = Object.hasOwn(request, 'id');
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return null;
  if (!hasId) return null;
  if (request.method === 'initialize') {
    const requestedVersion = request.params && request.params.protocolVersion;
    return makeResponse(request.id, {
      protocolVersion: PROTOCOL_VERSIONS.has(requestedVersion) ? requestedVersion : '2025-11-25',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'codex-delegation-identity-probe', version: '0.1.0' },
    });
  }
  if (request.method === 'tools/list') {
    return makeResponse(request.id, {
      tools: [{
        name: TOOL_NAME,
        description: 'Returns allowlisted runner registration and native thread identity metadata.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string' },
            agent_id: { type: 'string' },
          },
          additionalProperties: false,
        },
      }],
    });
  }
  if (request.method === 'tools/call') {
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params : {};
    if (params.name !== TOOL_NAME) return makeError(request.id, -32602, 'Unknown tool');
    const meta = params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta) ? params._meta : {};
    const probe = buildIdentityProbe({}, environment, meta);
    return makeResponse(request.id, { content: [{ type: 'text', text: JSON.stringify(probe) }] });
  }
  return makeError(request.id, -32601, 'Method not found');
}

function writeMcpResponse(output, response) {
  if (!response) return true;
  const line = Buffer.from(`${JSON.stringify(response)}\n`, 'utf8');
  if (line.length > MAX_OUTPUT_BYTES) return false;
  output.write(line);
  return true;
}

function attachBoundedMcpReader(input, output, environment = process.env) {
  let pending = Buffer.alloc(0);
  let discarding = false;
  let ended = false;
  const consumeLine = (line) => {
    if (line.length > MAX_INPUT_BYTES) return;
    let request;
    try {
      request = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    writeMcpResponse(output, handleMcpRequest(request, environment));
  };
  const consume = (chunk) => {
    if (ended) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(0x0a, start);
      const end = newline < 0 ? data.length : newline;
      const piece = data.subarray(start, end);
      if (discarding) {
        if (newline >= 0) discarding = false;
      } else if (pending.length + piece.length > MAX_INPUT_BYTES) {
        pending = Buffer.alloc(0);
        discarding = newline < 0;
      } else if (newline >= 0) {
        consumeLine(Buffer.concat([pending, piece]));
        pending = Buffer.alloc(0);
      } else {
        pending = Buffer.concat([pending, piece]);
      }
      if (newline < 0) break;
      start = newline + 1;
    }
  };
  input.on('data', consume);
  input.on('end', () => {
    ended = true;
    if (pending.length && !discarding) consumeLine(pending);
    pending = Buffer.alloc(0);
  });
  input.on('error', () => {
    ended = true;
    pending = Buffer.alloc(0);
  });
}

function readBoundedInput(stream, maximumBytes = MAX_INPUT_BYTES) {
  return new Promise(resolve => {
    const chunks = [];
    let byteLength = 0;
    let tooLarge = false;
    stream.on('data', chunk => {
      if (tooLarge) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      if (byteLength > maximumBytes) {
        chunks.length = 0;
        tooLarge = true;
        return;
      }
      chunks.push(buffer);
    });
    stream.on('end', () => {
      if (tooLarge) return resolve(null);
      try {
        const parsed = JSON.parse(Buffer.concat(chunks, byteLength).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
      } catch {
        resolve(null);
      }
    });
    stream.on('error', () => resolve(null));
  });
}

async function runHook(input, filePath, environment = process.env, output = process.stdout) {
  if (input) appendHookRecord(input, filePath, environment);
  if (input && ['Stop', 'SubagentStop'].includes(input.hook_event_name)) output.write('{}\n');
}

async function main(argv = process.argv.slice(2), input = process.stdin, output = process.stdout) {
  if (argv[0] === '--mcp') return attachBoundedMcpReader(input, output);
  if (argv[0] === '--hook' && argv[1] === '--capture-file' && argv[2]) {
    const hookInput = await readBoundedInput(input);
    try {
      await runHook(hookInput, argv[2]);
    } catch {
      if (hookInput && ['Stop', 'SubagentStop'].includes(hookInput.hook_event_name)) output.write('{}\n');
    }
    return;
  }
  return null;
}

if (require.main === module) main();

module.exports = {
  MAX_HOOK_FILE_BYTES,
  MAX_INPUT_BYTES,
  TOOL_NAME,
  appendHookRecord,
  attachBoundedMcpReader,
  buildHookRecord,
  buildIdentityProbe,
  handleMcpRequest,
  main,
  nonceMatches,
  projectInheritedSession,
  projectRegistration,
  readBoundedInput,
  runHook,
  safeIdentifier,
};
