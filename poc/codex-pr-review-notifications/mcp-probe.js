'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const SERVER_NAME = 'poc164_native_fixture';
const PROTOCOL_VERSION = '2025-06-18';
const MAX_CAPTURE_BYTES = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CREDENTIAL_PREFIX = /^(?:sk-|gh[pousr]_|github_pat_|bearer\s|eyJ)/i;
const CODEX_ID_ENV_NAMES = [
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_AGENT_ID',
  'CODEX_TURN_ID',
];
const REGISTRATIONS = new Map();
let callCount = 0;

function isSafeIdentity(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) && !CREDENTIAL_PREFIX.test(value);
}

function safeIdentity(value) {
  return isSafeIdentity(value) ? value : 'unknown';
}

function safeMetaKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter(key => /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/.test(key))
    .slice(0, 32)
    .sort();
}

function parseFixturePullRequestUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' ||
      url.port || url.username || url.password || url.search || url.hash) return null;
  const match = /^\/(poc164-fixture)\/(agent-cockpit)\/pull\/(164)\/?$/i.exec(url.pathname);
  if (!match) return null;
  const owner = match[1].toLowerCase();
  const repo = match[2].toLowerCase();
  const number = Number(match[3]);
  return { owner, repo, number, key: owner + '/' + repo + '#' + number };
}

function captureConfiguration(environment = process.env) {
  const outputDirectory = environment.POC164_OUTPUT_DIRECTORY;
  const capturePath = environment.POC164_CAPTURE_PATH;
  if (typeof outputDirectory !== 'string' || typeof capturePath !== 'string') {
    throw new Error('capture_configuration_missing');
  }
  const output = path.resolve(outputDirectory);
  const capture = path.resolve(capturePath);
  if (path.dirname(capture) !== output || path.basename(capture) !== 'mcp-capture.jsonl') {
    throw new Error('capture_path_outside_output');
  }
  const outputStat = fs.lstatSync(output);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error('capture_output_not_directory');
  }
  const captureStat = fs.existsSync(capture) ? fs.lstatSync(capture) : null;
  if (captureStat && (!captureStat.isFile() || captureStat.isSymbolicLink())) {
    throw new Error('capture_target_not_regular_file');
  }
  return capture;
}

function writeCapture(event, environment = process.env) {
  const capturePath = captureConfiguration(environment);
  const line = JSON.stringify(event) + '\n';
  const existingSize = fs.existsSync(capturePath) ? fs.lstatSync(capturePath).size : 0;
  if (existingSize + Buffer.byteLength(line, 'utf8') > MAX_CAPTURE_BYTES) {
    throw new Error('capture_size_limit_exceeded');
  }
  fs.appendFileSync(capturePath, line, { encoding: 'utf8', mode: 0o600 });
}

function readOnlyEnvironmentIds(environment = process.env) {
  return Object.fromEntries(CODEX_ID_ENV_NAMES.map(name => [
    name,
    typeof environment[name] === 'string' && environment[name].length > 0,
  ]));
}

function makeResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function buildToolCallResult(params, environment = process.env) {
  const args = params && params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments
    : {};
  const pullRequest = parseFixturePullRequestUrl(args.url);
  if (!pullRequest) {
    return { error: 'fixture_pr_url_rejected' };
  }

  const meta = params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta)
    ? params._meta
    : {};
  const nativeThreadId = safeIdentity(meta.threadId);
  const registration = REGISTRATIONS.get(pullRequest.key) || {
    sources: new Set(),
    callCount: 0,
  };
  const isDuplicate = registration.callCount > 0;
  registration.callCount += 1;
  if (nativeThreadId !== 'unknown') registration.sources.add(nativeThreadId);
  REGISTRATIONS.set(pullRequest.key, registration);
  callCount += 1;

  const event = {
    type: 'tool_call',
    tool: 'cockpit_add_pr',
    pr_key: pullRequest.key,
    native_meta_thread_id: nativeThreadId,
    meta_keys: safeMetaKeys(meta),
    codex_environment_ids_present: readOnlyEnvironmentIds(environment),
    registration: isDuplicate ? 'duplicate' : 'created',
    unique_native_sources_for_fixture_pr: registration.sources.size,
  };
  writeCapture(event, environment);

  return {
    fixture: SERVER_NAME,
    pr_key: pullRequest.key,
    registration: event.registration,
    native_meta_thread_id: nativeThreadId,
    native_meta_thread_id_present: nativeThreadId !== 'unknown',
    unique_pr_count: REGISTRATIONS.size,
    call_count: callCount,
    unique_native_sources_for_fixture_pr: registration.sources.size,
  };
}

function handleRequest(request, environment = process.env) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return request && Object.hasOwn(request, 'id')
      ? makeError(request.id, -32600, 'Invalid request')
      : null;
  }
  if (request.method.startsWith('notifications/')) return null;
  if (!Object.hasOwn(request, 'id')) return null;

  if (request.method === 'initialize') {
    return makeResponse(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: '0.1.0' },
    });
  }
  if (request.method === 'ping') return makeResponse(request.id, {});
  if (request.method === 'tools/list') {
    return makeResponse(request.id, {
      tools: [{
        name: 'cockpit_add_pr',
        description: 'Records one fixed synthetic PR in an in-memory fixture.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', maxLength: 2000 } },
          required: ['url'],
          additionalProperties: false,
        },
      }],
    });
  }
  if (request.method === 'tools/call') {
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params
      : {};
    if (params.name !== 'cockpit_add_pr') return makeError(request.id, -32602, 'Unknown fixture tool');
    const result = buildToolCallResult(params, environment);
    if (result.error) {
      return makeResponse(request.id, {
        content: [{ type: 'text', text: result.error }],
        isError: true,
      });
    }
    return makeResponse(request.id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    });
  }
  return makeError(request.id, -32601, 'Method not found');
}

async function main(input = process.stdin, output = process.stdout, environment = process.env) {
  writeCapture({
    type: 'started',
    pid: process.pid,
    parent_pid: process.ppid,
    codex_environment_ids_present: readOnlyEnvironmentIds(environment),
  }, environment);
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  reader.on('line', line => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      output.write(JSON.stringify(makeError(null, -32700, 'Parse error')) + '\n');
      return;
    }
    let response;
    try {
      response = handleRequest(request, environment);
    } catch {
      response = request && Object.hasOwn(request, 'id')
        ? makeError(request.id, -32603, 'Fixture capture failed')
        : null;
    }
    if (response) output.write(JSON.stringify(response) + '\n');
  });
  reader.on('close', () => {
    writeCapture({
      type: 'stdin_closed',
      pid: process.pid,
      call_count: callCount,
    }, environment);
  });
  await new Promise(resolve => reader.once('close', resolve));
}

process.once('exit', exitCode => {
  try {
    if (typeof process.env.POC164_CAPTURE_PATH !== 'string') return;
    writeCapture({
      type: 'process_exit',
      pid: process.pid,
      exit_code: Number.isInteger(exitCode) ? exitCode : null,
    });
  } catch {
  }
});

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  buildToolCallResult,
  captureConfiguration,
  handleRequest,
  isSafeIdentity,
  parseFixturePullRequestUrl,
  safeMetaKeys,
};
