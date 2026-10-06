'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NativeExecError,
  classifyObservation,
  createJsonlCollector,
  parseArguments,
  safeFixtureSummary,
} = require('./run-native-exec');

function child(overrides = {}) {
  return {
    exit_code: 0,
    signal: 'none',
    timed_out: false,
    interrupted: false,
    child_exited: true,
    spawn_error_kind: 'none',
    events: createJsonlCollector().finish(),
    ...overrides,
  };
}

function fixture(overrides = {}) {
  return {
    requests: [{ tool_names: ['echo', 'request_user_input'] }],
    unsupported: null,
    callSummary: {
      targetTool: 'request_user_input',
      questions: [{ option_count: 2, free_form_enabled: true }],
    },
    answerOutput: { call_output_seen: false },
    ...overrides,
  };
}

test('exec runner accepts only the pinned native-exec arguments and bounded timeout', () => {
  const parsed = parseArguments(['--codex-path', 'codex.exe', '--out', 'poc/out/exec-probe', '--timeout-ms', '30000']);
  assert.equal(parsed.timeoutMs, 30000);
  assert.equal(parsed.outputDirectory, 'poc/out/exec-probe');
  assert.equal(parseArguments(['--codex-path', 'codex.exe', '--out', 'poc/out/exec-single', '--question-profile', 'single']).questionProfile, 'single');
  assert.throws(() => parseArguments(['--codex-path', 'codex.exe', '--out', 'poc/out/a', '--serve']), NativeExecError);
  assert.throws(() => parseArguments(['--codex-path', 'codex.exe', '--out', 'poc/out/a', '--timeout-ms', '999']), NativeExecError);
  assert.throws(() => parseArguments(['--codex-path', 'codex.exe', '--out', 'poc/out/a', '--question-profile', 'coerce']), NativeExecError);
});

test('exec observation distinguishes an unavailable tool from an unsupported declared schema', () => {
  const unavailable = classifyObservation(fixture({
    requests: [{ tool_names: ['echo'] }],
    unsupported: 'request_user_input_unavailable',
    callSummary: null,
  }), child());
  assert.equal(unavailable.availability, 'unavailable');
  assert.equal(unavailable.outcome, 'tool_unavailable');

  const unsupported = classifyObservation(fixture({
    unsupported: 'question_schema_unsupported',
    callSummary: null,
  }), child());
  assert.equal(unsupported.availability, 'unsupported_schema');
  assert.equal(unsupported.outcome, 'unsupported_schema');
  assert.equal(unsupported.fixture.unsupported_reason, 'question_schema_unsupported');
});

test('a fixture-generated question function call that times out stays unresolved', () => {
  const observed = classifyObservation(fixture(), child({
    timed_out: true,
    exit_code: 'unknown',
  }));
  assert.equal(observed.availability, 'call_emitted_unresolved');
  assert.equal(observed.outcome, 'exec_timeout_after_question_call');
  assert.equal(observed.error_kind, 'timeout');
  assert.equal(observed.fixture.fixture_function_call_emitted, true);
  assert.equal(observed.fixture.response_output_seen, false);
});

test('exec event projection keeps counts and statuses but drops IDs, prompts, answers, and raw errors', () => {
  const collector = createJsonlCollector();
  const lines = [
    { type: 'thread.started', thread_id: 'native-thread-sensitive-id' },
    { type: 'item.started', item: { id: 'native-item-sensitive-id', type: 'dynamic_tool_call', tool: 'request_user_input', arguments: 'private prompt text' } },
    { type: 'item.completed', item: { id: 'native-item-sensitive-id', type: 'dynamic_tool_call', tool: 'request_user_input', status: 'failed', result: 'private answer text' } },
    { type: 'turn.failed', error: { code: 'private-error-code', message: 'private error body' } },
  ];
  for (const line of lines) collector.consumeStdout(`${JSON.stringify(line)}\n`);
  const projected = collector.finish();
  const summary = JSON.stringify(projected);
  for (const secret of ['native-thread-sensitive-id', 'native-item-sensitive-id', 'private prompt text', 'private answer text', 'private-error-code', 'private error body']) {
    assert.equal(summary.includes(secret), false);
  }
  assert.equal(projected.native_thread_count, 1);
  assert.equal(projected.native_item_count, 1);
  assert.equal(projected.request_user_input_item_count, 1);
  assert.equal(projected.request_user_input_item_event_count, 2);
  assert.equal(projected.turn_status, 'failed');

  const fixtureProjection = safeFixtureSummary({
    requests: [{ tool_names: ['request_user_input', 'safe.tool'] }],
    unsupported: null,
    callSummary: {
      target_tool: 'request_user_input',
      question_profile: 'single',
      call_id: 'private-call-id',
      item_id: 'private-item-id',
      questions: [{ text: 'private question', option_count: 2, free_form_enabled: true }],
    },
    answerOutput: {
      call_output_seen: true,
      tool_output_error_kind: 'default_mode_unavailable',
      fixed_answer: 'private answer',
    },
  });
  const fixtureSummary = JSON.stringify(fixtureProjection);
  for (const secret of ['private-call-id', 'private-item-id', 'private question', 'private answer']) {
    assert.equal(fixtureSummary.includes(secret), false);
  }
  assert.deepEqual(fixtureProjection.available_tool_names, ['request_user_input', 'safe.tool']);
  assert.equal(fixtureProjection.fixture_function_call_emitted, true);
  assert.equal(fixtureProjection.question_profile, 'single');
  assert.equal(fixtureProjection.response_output_seen, true);
  assert.equal(fixtureProjection.tool_output_error_kind, 'default_mode_unavailable');

  const unclassifiedOutput = safeFixtureSummary({
    requests: [],
    unsupported: null,
    callSummary: null,
    answerOutput: { call_output_seen: true, tool_output_error_kind: 'private raw output' },
  });
  assert.equal(unclassifiedOutput.tool_output_error_kind, 'unknown');
  assert.equal(JSON.stringify(unclassifiedOutput).includes('private raw output'), false);
});
