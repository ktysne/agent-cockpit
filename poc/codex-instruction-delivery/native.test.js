'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { REPOSITORY_ROOT, REQUIRED_CODEX_VERSION } = require('../codex-hooks-identity/setup');
const {
  MARKERS,
  NativeInstructionError,
  calculateFeatureFlowSuccess,
  calculateMeasurementSuccess,
  calculateStateProbeSuccess,
  createMarkerTargets,
  createObserver,
  createResult,
  exactMarkerInput,
  parseArguments,
  parseControlLine,
  runNativeProbe,
  specialWaitingFlags,
} = require('./native-runner');

const OUTPUT_PARENT = path.join(REPOSITORY_ROOT, 'poc', 'out');
const UUID_A = '01a10000-0000-7000-8000-000000000001';
const UUID_B = '01a10000-0000-7000-8000-000000000002';
const UUID_C = '01a10000-0000-7000-8000-000000000003';

function createOutputPath() {
  const output = path.join(OUTPUT_PARENT, `poc161-native-test-${randomUUID()}`);
  assert.equal(path.dirname(output), OUTPUT_PARENT);
  assert.equal(fs.existsSync(output), false);
  return output;
}

function relativeOutput(output) {
  return path.relative(REPOSITORY_ROOT, output).split(path.sep).join('/');
}

function removeOwnedOutput(output) {
  const resolved = path.resolve(output);
  assert.equal(path.dirname(resolved), path.resolve(OUTPUT_PARENT));
  const parentStat = fs.lstatSync(OUTPUT_PARENT);
  assert.equal(parentStat.isDirectory(), true);
  assert.equal(parentStat.isSymbolicLink(), false);
  if (!fs.existsSync(resolved)) return;
  const targetStat = fs.lstatSync(resolved);
  assert.equal(targetStat.isDirectory(), true);
  assert.equal(targetStat.isSymbolicLink(), false);
  fs.rmSync(resolved, { recursive: true, force: false });
}

function prepareQueueCliMeasurement(result) {
  result.target_version = REQUIRED_CODEX_VERSION;
  result.thread.same_id = true;
  result.settings.start_resume_match = true;
  result.turns.push({ role: 'thread_materialization_warmup', terminal_observed: true,
    status_a: 'completed', fixture_input_seen: true });
}

function makeFixture(stats) {
  return {
    baseUrl: 'http://127.0.0.1:43123',
    requestHeaders: { 'X-Poc161-Token': 'a'.repeat(64) },
    requests: [],
    unsupported: false,
    async start() { stats.fixtureStarted += 1; },
    release() { stats.fixtureReleased += 1; },
    async close() {
      stats.fixtureClosed += 1;
      return true;
    },
  };
}

function makeRuntimeHome(output) {
  const runtimeHomes = path.join(output, 'runtime-homes');
  fs.mkdirSync(runtimeHomes, { recursive: true });
  const home = path.join(runtimeHomes, randomUUID());
  const repo = path.join(home, 'repo');
  const configPath = path.join(home, 'config.toml');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(configPath, '[history]\npersistence = "save-all"\n', { encoding: 'utf8', flag: 'wx' });
  return { output, home, repo, configPath };
}

function failureDependencies(scenario, output, signalSource, stats) {
  let fakeServer = null;
  const dependencies = {
    signalSource,
    setup({ outputDirectory }) {
      stats.setupCalls += 1;
      assert.equal(path.resolve(REPOSITORY_ROOT, outputDirectory), output);
      if (scenario === 'setup') throw new NativeInstructionError('test_setup_failed');
      fs.mkdirSync(output);
    },
    validatePaths(codexPath) {
      stats.validatePathsCalls += 1;
      return { executable: codexPath, layout: { output } };
    },
    createRuntimeHome() {
      stats.createdLayout = makeRuntimeHome(output);
      return stats.createdLayout;
    },
    createFixture() {
      stats.fixture = makeFixture(stats);
      return stats.fixture;
    },
    async runVersionCheck() {
      return { version: scenario === 'version' ? '0.159.2' : REQUIRED_CODEX_VERSION };
    },
    choosePort: async () => 43123,
    startServer(_executable, _cwd, _home, _port, tokenPath) {
      stats.tokenPath = tokenPath;
      fakeServer = {
        state: { closed: false },
        exited: Promise.resolve(true),
        child: {
          kill() {
            stats.serverKillCalls += 1;
            fakeServer.state.closed = true;
          },
        },
      };
      stats.server = fakeServer;
      return fakeServer;
    },
    async connect(options) {
      stats.connectCalls += 1;
      assert.match(options.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
      assert.match(options.authToken, /^[0-9a-f]{64}$/);
      throw Object.assign(new Error('private connection detail'), { kind: 'mock_connect_failure' });
    },
  };
  return dependencies;
}

test('CLI options reject legacy/experimental flags, duplicates, and invalid values', () => {
  const parsed = parseArguments(['--codex-path', 'C:\\tools\\codex.exe', '--mode', 'tool', '--timeout-ms', '1000']);
  assert.equal(parsed.mode, 'tool');
  assert.equal(parsed.timeoutMs, 1000);
  assert.equal(parsed.serve, false);
  assert.equal(parseArguments(['--codex-path', 'C:\\tools\\codex.exe', '--mode', 'queue-cli']).mode, 'queue-cli');
  assert.equal(parseArguments(['--codex-path', 'C:\\tools\\codex.exe', '--serve']).serve, true);
  for (const argv of [
    ['--codex-path', 'C:\\tools\\codex.exe', '--experimental-api'],
    ['--codex-path', 'C:\\tools\\codex.exe', '--capabilities'],
    ['--codex-path', 'C:\\tools\\codex.exe', '--codex-path', 'C:\\other\\codex.exe'],
    ['--codex-path', 'C:\\tools\\codex.exe', '--mode', 'questionnaire'],
    ['--codex-path', 'C:\\tools\\codex.exe', '--timeout-ms', '999'],
    ['--codex-path', 'C:\\tools\\codex.exe', '--timeout-ms', '1000', '--timeout-ms', '2000'],
  ]) {
    assert.throws(() => parseArguments(argv), (error) => error instanceof NativeInstructionError);
  }
});

test('control lines and marker inputs accept only bounded allowlisted commands', () => {
  const markerName = Object.keys(MARKERS)[0];
  assert.deepEqual(parseControlLine(JSON.stringify({ op: 'start', marker: markerName })), {
    op: 'start', marker: markerName,
  });
  assert.deepEqual(parseControlLine(JSON.stringify({ op: 'steer', marker: markerName, turn: 'active' })), {
    op: 'steer', marker: markerName, turn: 'active',
  });
  for (const line of [
    JSON.stringify({ op: 'start', marker: 'arbitrary user text' }),
    JSON.stringify({ op: 'stop', command: 'extra' }),
    JSON.stringify({ op: 'steer', marker: markerName, turn: 'new-turn' }),
    JSON.stringify({ op: 'start', marker: markerName, payload: 'secret' }),
    '{invalid json',
    'x'.repeat(5000),
  ]) assert.equal(parseControlLine(line), null);
  assert.deepEqual(exactMarkerInput(MARKERS[markerName]), [{ type: 'text', text: MARKERS[markerName] }]);
  assert.throws(() => exactMarkerInput('free-form user text'), (error) => error.kind === 'marker_not_allowlisted');
});

test('marker projection requires exact marker, client, thread, turn, and same item tuple', () => {
  const result = createResult({ mode: 'lifecycle' });
  const targets = createMarkerTargets(UUID_A, result);
  targets.register('initial', UUID_B);
  targets.observe('initial', { threadId: UUID_A, turnId: UUID_C, clientId: UUID_B, itemId: 'item-delayed' });
  assert.equal(result.native_user_markers.initial, false);
  targets.bindTurn('initial', UUID_C);
  assert.equal(result.native_user_markers.initial, true);
  assert.deepEqual(result.native_user_marker_evidence.initial, {
    exact_text_match: true,
    same_item_tuple_match: true,
    same_item_thread_turn_match: true,
    expected_client_message_id_match: true,
    native_item_count: 1,
    unique_native_item_count: 1,
  });

  targets.register('steer', UUID_B);
  targets.bindTurn('steer', UUID_C);
  targets.observe('steer', { threadId: UUID_A, turnId: UUID_C, clientId: 'wrong-client', itemId: 'item-wrong-client' });
  assert.equal(result.native_user_markers.steer, false);
  targets.register('second', UUID_B);
  targets.bindTurn('second', UUID_C);
  targets.observe('second', { threadId: 'wrong-thread', turnId: UUID_C, clientId: UUID_B, itemId: 'item-wrong-thread' });
  assert.equal(result.native_user_markers.second, false);
  targets.register('queueA', UUID_B);
  targets.bindTurn('queueA', UUID_C);
  targets.observe('queueA', { threadId: UUID_A, turnId: UUID_C, clientId: UUID_B, itemId: 'item-conflict' });
  targets.observe('queueA', { threadId: UUID_A, turnId: UUID_B, clientId: UUID_B, itemId: 'item-conflict' });
  assert.equal(result.native_user_markers.queueA, false);
  assert.equal(result.native_user_marker_evidence.queueA.same_item_tuple_match, false);
});

test('observer counts question and approval requests without retaining request content', () => {
  const observer = createObserver();
  observer.onServerRequest({ method: 'item/tool/requestUserInput', params: { prompt: 'private question text' } });
  observer.onServerRequest({ method: 'item/commandExecution/requestApproval', params: { command: 'private command' } });
  observer.onServerRequest({ method: 'unknown/method', params: { body: 'private body' } });
  observer.onNotification('thread/status/changed', {
    threadId: UUID_A,
    turnId: UUID_B,
    status: 'inProgress',
    threadStatus: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] },
    content: 'private notification content',
  });
  observer.onNotification('thread/status/changed', {
    threadId: UUID_A,
    turnId: UUID_B,
    status: 'inProgress',
    threadStatus: { type: 'active', activeFlags: [] },
  });

  const summary = observer.summary();
  assert.deepEqual(summary.server_requests, { approval: 1, question: 1, other: 1, total: 3, resolved: 0 });
  assert.deepEqual(summary.waiting_on_approval, { seen: true, active: false, cleared: true });
  assert.deepEqual(summary.waiting_on_user_input, { seen: true, active: false, cleared: true });
  assert.equal(JSON.stringify(summary).includes('private'), false);
});

test('item completion does not end its turn and only turn completion is terminal', () => {
  const observer = createObserver();
  const turn = { threadId: UUID_A, turnId: UUID_B };
  observer.onNotification('turn/started', { ...turn, status: 'inProgress' });
  observer.onNotification('item/completed', { ...turn, status: 'completed', itemType: 'agentMessage' });
  assert.equal(observer.turnStatuses.get(UUID_B), 'inProgress');

  observer.onNotification('turn/completed', { ...turn, status: 'completed' });
  assert.equal(observer.turnStatuses.get(UUID_B), 'completed');
});

test('遅延startedとunknown turn statusは終端turnを復活させない', () => {
  const observer = createObserver();
  const turn = { threadId: UUID_A, turnId: UUID_B };
  observer.onNotification('turn/completed', { ...turn, status: 'completed' });
  observer.onNotification('turn/started', { ...turn, status: 'inProgress' });
  observer.onNotification('turn/status/changed', { ...turn, status: 'futureStatus' });
  assert.equal(observer.turnStatuses.get(UUID_B), 'completed');
});

test('active waiting flags clear when the thread becomes idle', () => {
  const observer = createObserver();
  const thread = { threadId: UUID_A, turnId: UUID_B };
  observer.onNotification('thread/status/changed', {
    ...thread,
    threadStatus: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] },
  });
  assert.equal(observer.summary().waiting_on_approval.active, true);
  assert.equal(observer.summary().waiting_on_user_input.active, true);

  observer.onNotification('thread/status/changed', {
    ...thread,
    threadStatus: { type: 'idle' },
  });
  assert.deepEqual(observer.summary().waiting_on_approval, { seen: true, active: false, cleared: true });
  assert.deepEqual(observer.summary().waiting_on_user_input, { seen: true, active: false, cleared: true });
});

test('unknown thread and turn statuses do not clear active waiting flags or overwrite known turn state', () => {
  const observer = createObserver();
  const turn = { threadId: UUID_A, turnId: UUID_B };
  observer.onNotification('turn/started', { ...turn, status: 'inProgress' });
  observer.onNotification('thread/status/changed', {
    ...turn,
    threadStatus: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] },
  });
  observer.onNotification('turn/status/changed', { ...turn, status: 'futureStatus' });
  observer.onNotification('thread/status/changed', {
    ...turn,
    threadStatus: { type: 'futureState', activeFlags: [] },
  });

  assert.equal(observer.turnStatuses.get(UUID_B), 'inProgress');
  assert.deepEqual(observer.summary().waiting_on_approval, { seen: true, active: true, cleared: false });
  assert.deepEqual(observer.summary().waiting_on_user_input, { seen: true, active: true, cleared: false });
});

test('approval and question special cases record their matching waiting flags', () => {
  const approval = { seen: true, active: true, cleared: false };
  const question = { seen: true, active: false, cleared: true };
  const summary = { waiting_on_approval: approval, waiting_on_user_input: question };

  assert.equal(specialWaitingFlags('approval', summary), approval);
  assert.equal(specialWaitingFlags('question', summary), question);
  assert.equal(specialWaitingFlags('other', summary), null);
});

test('measurement, state-probe, and actual instruction delivery remain separate results', () => {
  const result = createResult({ mode: 'tool' });
  result.target_version = REQUIRED_CODEX_VERSION;
  result.thread.same_id = true;
  result.settings.start_resume_match = true;
  result.turns.push(
    { role: 'thread_materialization_warmup', terminal_observed: true, status_a: 'completed', fixture_input_seen: true },
    { role: 'tool', terminal_observed: true, fixture_gate_observed: true },
  );
  assert.equal(calculateMeasurementSuccess(result), true);
  result.measurement_success = true;
  assert.equal(calculateStateProbeSuccess(result), false);
  result.fixture.exec_tool_declared = true;
  result.fixture.call_output_count = 1;
  assert.equal(calculateStateProbeSuccess(result), true);
  assert.equal(calculateFeatureFlowSuccess(result), null);
  assert.equal(result.ordinary_instruction_delivery_observed, false);
  assert.equal(Object.values(result.native_user_markers).some(Boolean), false);
});

test('queue/list acceptance alone does not establish ordinary delivery or feature-flow success', () => {
  const result = createResult({ mode: 'queue-cli' });
  prepareQueueCliMeasurement(result);
  result.queue.list_before = { accepted: true };
  result.queue.list_after = { accepted: true };
  result.queue.cli = {
    list_before_accepted: true,
    list_after_accepted: true,
    marker_seen_in_queue_count: 1,
    queue_received: true,
    fixture_input_seen: false,
    native_user_item_thread_turn_seen: false,
    native_client_message_id_known: false,
    delivery_completed: false,
    measurement_completed: true,
  };

  assert.equal(calculateMeasurementSuccess(result), true);
  result.measurement_success = true;
  assert.equal(calculateFeatureFlowSuccess(result), false);
  assert.equal(result.ordinary_instruction_delivery_observed, false);
  assert.equal(result.native_user_markers.queueCli, false);
});

test('same-thread-turn item observation keeps unknown client correlation separate from dashboard application', () => {
  const result = createResult({ mode: 'queue-cli' });
  prepareQueueCliMeasurement(result);
  result.queue.cli = {
    fixture_input_seen: true,
    native_user_item_thread_turn_seen: true,
    native_client_message_id_known: false,
    delivery_completed: false,
    measurement_completed: true,
  };
  result.native_user_marker_evidence.queueCli = {
    exact_text_match: true,
    same_item_tuple_match: false,
    same_item_thread_turn_match: true,
    expected_client_message_id_match: null,
    native_item_count: 1,
    unique_native_item_count: 1,
  };

  assert.equal(calculateMeasurementSuccess(result), true);
  result.measurement_success = true;
  result.ordinary_instruction_delivery_observed = true;
  assert.equal(result.queue.cli.native_user_item_thread_turn_seen, true);
  assert.equal(result.queue.cli.native_client_message_id_known, false);
  assert.equal(result.native_user_marker_evidence.queueCli.same_item_thread_turn_match, true);
  assert.equal(result.native_user_marker_evidence.queueCli.expected_client_message_id_match, null);
  assert.equal(result.native_user_marker_evidence.queueCli.same_item_tuple_match, false);
  assert.equal(calculateFeatureFlowSuccess(result), false);
  assert.equal(result.ordinary_instruction_delivery_observed, true);
});

test('fresh-output guard leaves an existing result directory byte-for-byte untouched', async () => {
  const output = createOutputPath();
  fs.mkdirSync(output);
  const sentinelPath = path.join(output, 'sentinel.txt');
  fs.writeFileSync(sentinelPath, 'preserve-existing-output\n', { encoding: 'utf8', flag: 'wx' });
  const signalSource = new EventEmitter();
  let setupCalls = 0;
  try {
    const result = await runNativeProbe({
      codexPath: process.execPath,
      outputDirectory: relativeOutput(output),
      timeoutMs: 1000,
      mode: 'lifecycle',
    }, {
      signalSource,
      setup() { setupCalls += 1; },
    });
    assert.equal(result.failure_code, 'output_directory_not_fresh');
    assert.equal(setupCalls, 0);
    assert.equal(result.result_file, undefined);
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'preserve-existing-output\n');
    assert.deepEqual(fs.readdirSync(output), ['sentinel.txt']);
    assert.equal(signalSource.listenerCount('SIGINT'), 0);
    assert.equal(signalSource.listenerCount('SIGTERM'), 0);
  } finally {
    removeOwnedOutput(output);
  }
});

test('setup, version, and connection failures release only owned resources and remove signal listeners', async () => {
  for (const scenario of ['setup', 'version', 'connect']) {
    const output = createOutputPath();
    const signalSource = new EventEmitter();
    const stats = {
      setupCalls: 0,
      validatePathsCalls: 0,
      fixtureStarted: 0,
      fixtureReleased: 0,
      fixtureClosed: 0,
      serverKillCalls: 0,
      connectCalls: 0,
      fixture: null,
      server: null,
      tokenPath: null,
      createdLayout: null,
    };
    try {
      const result = await runNativeProbe({
        codexPath: process.execPath,
        outputDirectory: relativeOutput(output),
        timeoutMs: 1000,
        mode: 'lifecycle',
      }, failureDependencies(scenario, output, signalSource, stats));

      assert.equal(result.failure_stage, scenario === 'setup' ? 'setup' : scenario === 'version' ? 'version_check' : 'connect_a');
      assert.ok(result.failure_code);
      assert.equal(signalSource.listenerCount('SIGINT'), 0);
      assert.equal(signalSource.listenerCount('SIGTERM'), 0);
      if (scenario === 'setup') {
        assert.equal(result.failure_code, 'test_setup_failed');
        assert.equal(fs.existsSync(output), false);
        assert.equal(stats.fixtureStarted, 0);
      } else {
        assert.equal(stats.fixtureStarted, 1);
        assert.equal(stats.fixtureReleased, 1);
        assert.equal(stats.fixtureClosed, 1);
        assert.equal(result.cleanup.fixture_closed, true);
        assert.equal(result.cleanup.private_home_removed, true);
        assert.equal(fs.existsSync(stats.createdLayout.home), false);
        const savedResultPath = path.resolve(REPOSITORY_ROOT, result.result_file);
        assert.equal(path.dirname(savedResultPath), output);
        assert.equal(fs.existsSync(savedResultPath), true);
        const savedResult = fs.readFileSync(savedResultPath, 'utf8');
        assert.equal(JSON.parse(savedResult).failure_code, result.failure_code);
        assert.equal(savedResult.includes(stats.fixture.requestHeaders['X-Poc161-Token']), false);
      }
      if (scenario === 'version') {
        assert.equal(result.failure_code, 'unsupported_native_version');
        assert.equal(stats.server, null);
        assert.equal(result.cleanup.server_stopped, true);
      }
      if (scenario === 'connect') {
        assert.equal(result.failure_code, 'app_server_connect_mock_connect_failure');
        assert.ok(stats.connectCalls > 0);
        assert.equal(stats.serverKillCalls, 1);
        assert.equal(result.cleanup.server_stopped, true);
        assert.equal(result.cleanup.private_config_restored, true);
        assert.equal(result.cleanup.token_file_removed, true);
        assert.equal(fs.existsSync(stats.tokenPath), false);
      }
      assert.equal(result.success, false);
      assert.equal(result.measurement_success, false);
    } finally {
      removeOwnedOutput(output);
    }
  }
});
