'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeChildEnvironment, parseArguments, versionFromText } = require('../tools/probes/common-question-runtime');

test('probe accepts a current Codex version without pinning an old patch release', () => {
  assert.equal(versionFromText('codex-cli 0.160.1'), '0.160.1');
  assert.equal(versionFromText('codex_cli/0.161.4'), '0.161.4');
  assert.equal(versionFromText('version unknown'), null);
});

test('probe child environments replace home paths and exclude inherited credentials', () => {
  const homes = {
    codex: 'C:\\probe\\codex',
    user: 'C:\\probe\\user',
    appData: 'C:\\probe\\appdata',
    localAppData: 'C:\\probe\\localappdata',
    temp: 'C:\\probe\\temp',
    cockpit: 'C:\\probe\\cockpit',
  };
  const environment = makeChildEnvironment({
    PATH: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\real-user',
    APPDATA: 'C:\\Users\\real-user\\AppData\\Roaming',
    CODEX_THREAD_ID: 'private-thread',
    OPENAI_API_KEY: 'private-key',
    CLAUDE_CODE_SESSION_ID: 'private-session',
  }, homes, true);
  assert.equal(environment.PATH, 'C:\\Windows\\System32');
  assert.equal(environment.USERPROFILE, homes.user);
  assert.equal(environment.CODEX_HOME, homes.codex);
  assert.equal(environment.AGENT_COCKPIT_HOME, homes.cockpit);
  assert.equal(Object.hasOwn(environment, 'CODEX_THREAD_ID'), false);
  assert.equal(Object.hasOwn(environment, 'OPENAI_API_KEY'), false);
  assert.equal(Object.hasOwn(environment, 'CLAUDE_CODE_SESSION_ID'), false);
});

test('probe argument parsing requires only the executable and a fresh output path', () => {
  assert.deepEqual(parseArguments(['--codex-path', 'C:\\codex.exe', '--out', 'poc/out/probe']), {
    codexPath: 'C:\\codex.exe', outputDirectory: 'poc/out/probe',
  });
  assert.throws(() => parseArguments(['--codex-path', 'C:\\codex.exe', '--out', 'poc/out/probe', '--out', 'poc/out/other']),
    (error) => error.code === 'invalid_arguments');
});
