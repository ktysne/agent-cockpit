'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { FIXTURE_TOOL } = require('../codex-hooks-identity/run-exec');
const { assertNoSymlinkComponents, REPOSITORY_ROOT } = require('../codex-hooks-identity/setup');
const { DelegationIdentityModel } = require('./identity-model');
const {
  buildResult,
  createConcurrencyTracker,
  createNativeEventCollector,
  makeSlots,
  runNativeProbe,
  summarizeModelProject,
} = require('./run-native');

function probeFor(slot, threadId) {
  return {
    registration: { run_id: slot.runId, attempt_id: slot.attemptId, nonce_match: true },
    inherited_session: { present: true, matches_expected: true },
    mcp_meta: { thread_id: threadId },
    private_nonce: 'do-not-retain-this-value',
  };
}

function projectedProbeFor(slot, threadId) {
  return {
    run_id: slot.runId,
    attempt_id: slot.attemptId,
    nonce_match: true,
    inherited_session_present: true,
    inherited_session_matches_expected: true,
    thread_id: threadId,
  };
}

function collectEvents(events) {
  const collector = createNativeEventCollector();
  const text = events.map(event => JSON.stringify(event)).join('\n') + '\n';
  collector.consume(Buffer.from(text, 'utf8'));
  return collector.finish();
}

function modelWithRegisteredSlots(slots) {
  const model = new DelegationIdentityModel();
  for (const slot of slots) {
    assert.ok(model.registerLaunch({
      launchId: slot.launchId,
      runId: slot.runId,
      attemptId: slot.attemptId,
      origin: slot.origin,
      hostId: slot.hostId,
      homeScope: slot.homeScope,
      parent: slot.parent,
      bindingNonce: slot.bindingNonce,
    }));
  }
  return model;
}

function successfulChild(slot, threadId) {
  const turnId = randomUUID();
  return {
    exit_code: 0,
    signal: null,
    timed_out: false,
    interrupted: false,
    spawn_error_code: null,
    stderr_bytes: 0,
    stderr_overflow: false,
    bytes: 600,
    overflow: false,
    malformed_line_count: 0,
    omitted_event_count: 0,
    event_count: 3,
    event_counts: { 'thread.started': 1, 'turn.completed': 1 },
    thread_started_count: 1,
    thread_id: threadId,
    thread_id_count: 1,
    multiple_thread_ids: false,
    mcp_call_count: 1,
    mcp_probes: [projectedProbeFor(slot, threadId)],
    native_events: [
      { type: 'thread.started', thread_id: threadId, event_id: randomUUID() },
      { type: 'turn.completed', thread_id: threadId, turn_id: turnId, event_id: randomUUID(), status: 'completed' },
    ],
  };
}

function successfulBuildResult() {
  const slots = makeSlots();
  const model = modelWithRegisteredSlots(slots);
  const startedBySlot = [];
  const childBySlot = new Map();
  const hooksBySlot = new Map();
  const tracker = createConcurrencyTracker();
  for (const slot of slots) tracker.started(slot.launchId);
  for (const slot of slots) {
    const threadId = randomUUID();
    startedBySlot.push({
      slot,
      started: {
        layout: { repo: path.join(REPOSITORY_ROOT, 'poc', 'out', 'shared-test-cwd') },
        fixture: {
          requests: [
            { path: '/responses', toolNames: [FIXTURE_TOOL] },
            { path: '/responses', toolNames: [FIXTURE_TOOL] },
          ],
          unsupported: null,
        },
      },
      childEnvironment: { POC159_NONCE: slot.bindingNonce, POC159_EXPECTED_NONCE: slot.bindingNonce },
    });
    childBySlot.set(slot.launchId, successfulChild(slot, threadId));
    hooksBySlot.set(slot.launchId, {
      count: 0,
      registration_mismatch_count: 0,
      event_counts: {},
      session_ids: [],
      agent_ids: [],
      overflow: false,
    });
  }
  for (const slot of slots) tracker.ended(slot.launchId);
  const result = buildResult({
    slots,
    startedBySlot,
    childBySlot,
    hooksBySlot,
    model,
    tracker,
    outputDirectory: path.join(REPOSITORY_ROOT, 'poc', 'out', 'poc159-native-result'),
    setupFailure: null,
    stopSignal: null,
  });
  return { result, slots, model };
}

test('MCP probe is accepted only from the completed fixture MCP tool result', () => {
  const slot = makeSlots()[0];
  const threadId = randomUUID();
  const probe = probeFor(slot, threadId);
  const result = collectEvents([
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(probe) } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'other_server', tool: 'probe_identity', result: probe } },
    { type: 'item.started', item: { type: 'mcp_tool_call', server: 'poc157_identity', tool: 'probe_identity', result: probe } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'poc157_identity', tool: 'another_tool', result: probe } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'poc157_identity', tool: 'probe_identity', arguments: probe } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'poc157_identity', tool: 'probe_identity', result: probe } },
  ]);

  assert.equal(result.mcp_call_count, 1);
  assert.deepEqual(result.mcp_probes, [{
    run_id: slot.runId,
    attempt_id: slot.attemptId,
    nonce_match: true,
    inherited_session_present: true,
    inherited_session_matches_expected: true,
    thread_id: threadId,
  }]);
  assert.equal(JSON.stringify(result).includes('do-not-retain-this-value'), false);
});

test('four native slots can complete with hook-on unobserved and hook-off empty', () => {
  const { result } = successfulBuildResult();

  assert.equal(result.success, true, JSON.stringify({
    failure_reasons: result.failure_reasons,
    concurrency: result.concurrency,
    counts: result.registration_counts,
    projection: result.model_projection.counts,
    jobs: result.jobs.map(job => ({ started: job.started, native: job.native && {
      exit_code: job.native.exit_code,
      binding_attempted: job.native.binding_attempted,
      registration_matches: job.native.registration_matches,
      runner_nonce_matches: job.native.runner_nonce_matches,
      thread_matches_mcp_meta: job.native.thread_matches_mcp_meta,
      thread_id_count: job.native.thread_id_count,
      malformed_line_count: job.native.malformed_line_count,
      binding_accepted: job.native.binding_accepted,
      destination_matches_launch: job.native.destination_matches_launch,
      native_event_ingest_count: job.native.native_event_ingest_count,
      fixture_tool_seen: job.native.fixture_tool_seen,
      fixture_unsupported: job.native.fixture_unsupported,
      hook_rows_match_registration: job.native.hook_rows_match_registration,
      hook_disabled_has_no_rows: job.native.hook_disabled_has_no_rows,
    } })),
  }));
  assert.equal(result.concurrency.maximum_concurrent, 4);
  assert.equal(result.registration_counts.standalone, 2);
  assert.equal(result.registration_counts.delegated, 2);
  assert.equal(result.jobs.filter(job => job.hook_config_enabled).length, 3);
  assert.ok(result.jobs.every(job => job.native.binding_accepted));
  assert.ok(result.jobs.every(job => job.hook_capture.count === 0));
  assert.ok(result.jobs.every(job => job.native.hook_rows_match_registration && job.native.hook_disabled_has_no_rows));
});

test('multiple native thread IDs prevent binding even when one matches MCP metadata', () => {
  const slot = makeSlots()[1];
  const model = modelWithRegisteredSlots([slot]);
  let bindCalls = 0;
  const bindNative = model.bindNative.bind(model);
  model.bindNative = input => {
    bindCalls += 1;
    return bindNative(input);
  };
  const threadA = randomUUID();
  const threadB = randomUUID();
  const child = successfulChild(slot, threadA);
  child.thread_started_count = 2;
  child.thread_id = null;
  child.thread_id_count = 2;
  child.multiple_thread_ids = true;
  child.native_events.push({ type: 'thread.started', thread_id: threadB, event_id: randomUUID() });
  const started = {
    layout: { repo: path.join(REPOSITORY_ROOT, 'poc', 'out', 'shared-test-cwd') },
    fixture: { requests: [{ path: '/responses', toolNames: [FIXTURE_TOOL] }], unsupported: null },
  };
  const tracker = createConcurrencyTracker();
  tracker.started(slot.launchId);
  tracker.ended(slot.launchId);

  const result = buildResult({
    slots: [slot],
    startedBySlot: [{ slot, started, childEnvironment: { POC159_NONCE: slot.bindingNonce, POC159_EXPECTED_NONCE: slot.bindingNonce } }],
    childBySlot: new Map([[slot.launchId, child]]),
    hooksBySlot: new Map([[slot.launchId, { count: 0, registration_mismatch_count: 0, event_counts: {}, session_ids: [], agent_ids: [], overflow: false }]]),
    model,
    tracker,
    outputDirectory: path.join(REPOSITORY_ROOT, 'poc', 'out', 'poc159-native-result'),
    setupFailure: null,
    stopSignal: null,
  });

  assert.equal(bindCalls, 0);
  assert.equal(result.jobs[0].native.binding_attempted, false);
  assert.equal(result.jobs[0].native.binding_accepted, false);
  assert.equal(model.project().counts.related_unknown, 3);
});

test('model projection records execution_status as the public status', () => {
  const model = modelWithRegisteredSlots([makeSlots()[0]]);
  const projection = summarizeModelProject(model.project());

  assert.equal(projection.rows.length, 1);
  assert.equal(projection.rows[0].status, 'registered');
});

test('post-fixture hook setup failure closes every fixture and preserves a failed result', async t => {
  const outputName = `poc159-cleanup-${randomUUID()}`;
  const outputDirectory = path.join(REPOSITORY_ROOT, 'poc', 'out', outputName);
  const closedFixtures = [];
  const cleanedConfigs = [];
  const signalSource = new EventEmitter();
  const scopedOutput = path.resolve(path.join(REPOSITORY_ROOT, 'poc', 'out'));

  assert.equal(path.dirname(outputDirectory), scopedOutput);
  assert.equal(fs.existsSync(outputDirectory), false);
  t.after(() => {
    assertNoSymlinkComponents(REPOSITORY_ROOT, outputDirectory);
    if (fs.existsSync(outputDirectory)) fs.rmSync(outputDirectory, { recursive: true, force: false });
  });

  const result = await runNativeProbe({ codexPath: 'codex.exe', outputDirectory }, {
    signalSource,
    setup: ({ outputDirectory: target }) => {
      const home = path.join(target, 'home');
      const runtimeHomes = path.join(target, 'runtime-homes');
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(runtimeHomes, { recursive: true });
      fs.writeFileSync(path.join(home, 'config.toml'), '');
      fs.writeFileSync(path.join(home, 'hooks.json'), '{}\n');
      return { output: target, home, hooks: path.join(home, 'hooks'), repo: path.join(target, 'repo') };
    },
    startFixture: async target => {
      const runtimeHome = path.join(target, 'runtime-homes', randomUUID());
      fs.mkdirSync(runtimeHome, { recursive: true });
      const configPath = path.join(runtimeHome, 'config.toml');
      fs.writeFileSync(configPath, 'fixture config\n');
      const fixtureId = randomUUID();
      return {
        executable: 'codex.exe',
        layout: {
          output: target,
          home: runtimeHome,
          hooksPath: path.join(runtimeHome, 'missing-hooks.json'),
          repo: path.join(target, 'repo'),
        },
        configPath,
        configSnapshot: { fixtureId },
        fixture: {
          requests: [],
          unsupported: null,
          async close() { closedFixtures.push(fixtureId); },
        },
      };
    },
    clearFixtureConfig: (_configPath, snapshot) => {
      cleanedConfigs.push(snapshot.fixtureId);
      return true;
    },
  });

  assert.equal(closedFixtures.length, 4);
  assert.equal(new Set(closedFixtures).size, 4);
  assert.equal(cleanedConfigs.length, 4);
  assert.deepEqual(new Set(cleanedConfigs), new Set(closedFixtures));
  assert.equal(fs.existsSync(path.join(outputDirectory, 'runtime-homes')), false);
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
  assert.equal(result.result.success, false);
  assert.equal(result.result.setup_failure, 'error_enoent');
  assert.ok(result.result.jobs.every(job => job.started));
  assert.equal(fs.existsSync(result.filePath), true);
  const persisted = JSON.parse(fs.readFileSync(result.filePath, 'utf8'));
  assert.equal(persisted.success, false);
  assert.equal(persisted.setup_failure, 'error_enoent');
});
