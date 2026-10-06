'use strict';

const readline = require('node:readline');

const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const CODEX_ID_ENV_NAMES = [
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_AGENT_ID', 'CODEX_TURN_ID',
];
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const CREDENTIAL_PREFIX = /^(?:sk-|gh[pousr]_|github_pat_|bearer\s|eyJ)/i;

function isSafeIdentity(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && !CREDENTIAL_PREFIX.test(value);
}

function identityOrUnknown(value) {
  return isSafeIdentity(value) ? value : 'unknown';
}

function describeEnvironmentId(name, environment) {
  const value = environment[name];
  const present = typeof value === 'string' && value.length > 0;
  return {
    present,
    value: present ? identityOrUnknown(value) : 'unknown',
  };
}

function safeMetaKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter(key => /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/.test(key))
    .slice(0, 32)
    .sort();
}

function buildIdentityProbe(args = {}, environment = process.env, meta = {}) {
  const explicitSessionId = identityOrUnknown(args.session_id);
  const explicitAgentId = identityOrUnknown(args.agent_id);
  const metaThreadId = identityOrUnknown(meta.threadId);
  const claudeSession = environment.CLAUDE_CODE_SESSION_ID;
  const claudeSessionPresent = typeof claudeSession === 'string' && claudeSession.length > 0;

  return {
    explicit: {
      session_id: explicitSessionId,
      agent_id: explicitAgentId,
    },
    environment: {
      codex: Object.fromEntries(CODEX_ID_ENV_NAMES.map(name => [name, describeEnvironmentId(name, environment)])),
      claude_code_session: {
        present: claudeSessionPresent,
        matches_explicit_session_id: claudeSessionPresent && explicitSessionId !== 'unknown'
          ? claudeSession === explicitSessionId
          : null,
      },
    },
    mcp_meta: {
      keys: safeMetaKeys(meta),
      thread_id: metaThreadId,
      matches_explicit_session_id: metaThreadId !== 'unknown' && explicitSessionId !== 'unknown'
        ? metaThreadId === explicitSessionId
        : null,
    },
  };
}

function makeResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleRequest(request, environment = process.env) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return request && Object.hasOwn(request, 'id') ? makeError(request.id, -32600, 'Invalid request') : null;
  }
  const hasId = Object.hasOwn(request, 'id');
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return null;
  if (!hasId) return null;

  if (request.method === 'initialize') {
    const requestedVersion = request.params && request.params.protocolVersion;
    const protocolVersion = PROTOCOL_VERSIONS.has(requestedVersion) ? requestedVersion : LATEST_PROTOCOL_VERSION;
    return makeResponse(request.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'codex-hooks-identity-probe', version: '0.1.0' },
    });
  }

  if (request.method === 'tools/list') {
    return makeResponse(request.id, {
      tools: [{
        name: 'probe_identity',
        description: 'Returns explicit session and agent identifiers separately from a limited environment probe.',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
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
    const params = request.params && typeof request.params === 'object' ? request.params : {};
    if (params.name !== 'probe_identity') return makeError(request.id, -32602, 'Unknown tool');
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
    const probe = buildIdentityProbe(args, environment, params._meta && typeof params._meta === 'object' ? params._meta : {});
    return makeResponse(request.id, {
      content: [{ type: 'text', text: JSON.stringify(probe) }],
    });
  }

  return makeError(request.id, -32601, 'Method not found');
}

async function main(input = process.stdin, output = process.stdout) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(makeError(null, -32700, 'Parse error'))}\n`);
      continue;
    }
    const response = handleRequest(request);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

if (require.main === module) main();

module.exports = { buildIdentityProbe, handleRequest, isSafeIdentity, main };
