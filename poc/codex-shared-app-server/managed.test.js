'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { REPOSITORY_ROOT, makeLayout, renderConfig, renderHooksConfig } = require('../codex-hooks-identity/setup');
const { FIXTURE_MODEL } = require('../codex-hooks-identity/run-exec');
const { PocError } = require('./collector');
const {
  JSON_RPC_METHODS,
  buildPendingSuccess,
  buildSuccess,
  createClientObserver,
  inspectAdditionalLoadedThreads,
  prepareWorkspace,
  runManagedServer,
  summarizeServerRequestCorrelation,
} = require('./run-managed');

const THREAD_ID = '8b51b7b2-5ce1-4af2-a5a6-801171c27400';
const RESUMED_THREAD_ID = 'c0d7f5c5-740f-4a92-bfe4-9285f71d5002';
const WARMUP_TURN_ID = 'f86e20d8-d9f3-4d4a-bdc9-19ea99781c80';
const OBSERVED_TURN_ID = '9dc616d8-e98a-4b67-9db8-a92914841a7c';
const PENDING_TURN_ID = '5530023a-c5b6-47ab-bf81-a19d4412b00d';
const FOREIGN_THREAD_ID = 'd5f9a620-c90b-463e-97f5-2105fcb5f26c';
const PENDING_REQUEST_ID = 'request-approval-42';
const CODEX_VERSION = '0.160.0';
const NATIVE_CONFIG_SUFFIX = '\n[tui]\nscreen_reader_detection_done = true\n\n[hooks.state]\ntrusted_hash = "PRIVATE_TUI_HOOK_HASH"\n';

test('existing managed setup rejects edited config without overwriting it', (t) => {
  const output = makeOutputPath();
  t.after(() => removeTestOutput(output.absolute));
  const layout = makeLayout(output.absolute);
  fs.mkdirSync(layout.home, { recursive: true });
  fs.mkdirSync(path.join(layout.repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(layout.home, 'config.toml'), renderConfig(
    path.join(__dirname, '..', 'codex-hooks-identity', 'mcp-probe.js'),
  ));
  fs.writeFileSync(path.join(layout.home, 'hooks.json'), renderHooksConfig(
    path.join(layout.hooks, 'hook-logger.js'),
  ));

  assert.equal(prepareWorkspace(output.relative).home, layout.home);
  const configPath = path.join(layout.home, 'config.toml');
  const userEditedConfig = fs.readFileSync(configPath, 'utf8') + '# local edit\n';
  fs.writeFileSync(configPath, userEditedConfig);

  assert.throws(
    () => prepareWorkspace(output.relative),
    (error) => error.kind === 'existing_setup_mismatch',
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), userEditedConfig);
});

test('injected run preserves the warmup-resume-second-turn order and requires completed shared turns', async (t) => {
  const harness = makeHarness();
  t.after(() => removeTestOutput(harness.output.absolute));

  const result = await harness.run();

  assert.equal(result.success, true);
  assert.equal(result.turn.warmup.status, 'completed');
  assert.equal(result.turn.warmup.client_a_saw_turn_id, true);
  assert.equal(result.clients.b.same_thread_id, true);
  assert.equal(result.turn.observed.id, OBSERVED_TURN_ID);
  assert.equal(result.turn.observed.status_a, 'completed');
  assert.equal(result.turn.observed.status_b, 'completed');
  assert.equal(result.turn.observed.client_a_saw_turn_id, true);
  assert.equal(result.turn.observed.client_b_saw_turn_id, true);
  assert.equal(result.cleanup.server_stopped, true);
  assert.equal(result.cleanup.fixture_closed, true);
  assert.equal(result.cleanup.config_restored, true);
  assert.equal(result.cleanup.source_config_hash_unchanged, true);
  assert.equal(result.cleanup.token_file_removed, true);

  assert.deepEqual(harness.lifecycleCalls(), [
    ['a', 'turn/start'],
    ['b', 'thread/resume'],
    ['a', 'turn/start'],
  ]);
  assert.deepEqual(harness.calls.find((call) => call.method === 'thread/resume').params, {
    threadId: THREAD_ID,
    excludeTurns: true,
  });
  assert.equal(fs.readFileSync(harness.fixturePaths.configPath, 'utf8'), harness.fixturePaths.originalConfig);
  assert.equal(fs.existsSync(harness.spawnState.tokenPath), false);
  assert.equal(harness.spawnState.killCount, 1);
  assert.doesNotMatch(harness.resultJson, /PRIVATE_/);
  assert.equal(harness.resultJson.includes(harness.tokenValue), false);
  assert.equal(buildSuccess(result), true);

  const wrongThread = structuredClone(result);
  wrongThread.clients.b.same_thread_id = false;
  assert.equal(buildSuccess(wrongThread), false);
  const wrongTurn = structuredClone(result);
  wrongTurn.turn.observed.client_b_saw_turn_id = false;
  assert.equal(buildSuccess(wrongTurn), false);
  const incompleteTurn = structuredClone(result);
  incompleteTurn.turn.observed.status_b = 'failed';
  assert.equal(buildSuccess(incompleteTurn), false);
});

test('a resume RPC failure keeps only its safe category and still cleans owned resources', async (t) => {
  const harness = makeHarness({ resumeRpcFailure: true });
  t.after(() => removeTestOutput(harness.output.absolute));

  const result = await harness.run();

  assert.equal(result.success, false);
  assert.equal(result.failure_stage, 'thread_resume');
  assert.equal(result.failure_code, 'rpc_error');
  assert.equal(result.failure_rpc_code, -32600);
  assert.equal(result.failure_rpc_category, 'resume_unavailable');
  assert.equal(result.cleanup.server_stopped, true);
  assert.equal(result.cleanup.fixture_closed, true);
  assert.equal(result.cleanup.config_restored, true);
  assert.equal(result.cleanup.source_config_hash_unchanged, true);
  assert.equal(result.cleanup.token_file_removed, true);
  assert.equal(harness.spawnState.killCount, 1);
  assert.equal(fs.existsSync(harness.spawnState.tokenPath), false);
  assert.doesNotMatch(harness.resultJson, /PRIVATE_RPC_ERROR/);
});

test('cleanup removes fixture settings while preserving native TUI and hook state appended by CLI', async (t) => {
  const harness = makeHarness({ appendNativeConfigSuffixAtSpawn: true });
  t.after(() => removeTestOutput(harness.output.absolute));

  const result = await harness.run();

  assert.equal(result.success, true);
  assert.equal(result.cleanup.config_restored, false);
  assert.equal(result.cleanup.fixture_config_removed, true);
  assert.equal(result.cleanup.appended_config_preserved, true);
  assert.equal(fs.readFileSync(harness.fixturePaths.configPath, 'utf8'),
    harness.fixturePaths.originalConfig + NATIVE_CONFIG_SUFFIX);
  assert.doesNotMatch(fs.readFileSync(harness.fixturePaths.configPath, 'utf8'),
    /mcp_servers\.fixture|args = \["probe"\]/);
  assert.doesNotMatch(harness.resultJson, /PRIVATE_TUI_HOOK_HASH/);
  assert.equal(harness.resultJson.includes(harness.tokenValue), false);
});

test('an escaped runtime home is rejected before server start and fixture config is restored', async (t) => {
  const harness = makeHarness({ escapedRuntimeHome: os.homedir() });
  t.after(() => removeTestOutput(harness.output.absolute));

  const result = await harness.run();

  assert.equal(result.success, false);
  assert.equal(result.failure_code, 'private_home_outside_output');
  assert.equal(harness.spawnState.spawnCount, 0);
  assert.equal(result.cleanup.server_stopped, true);
  assert.equal(result.cleanup.fixture_closed, true);
  assert.equal(result.cleanup.config_restored, true);
  assert.equal(result.cleanup.source_config_hash_unchanged, true);
  assert.equal(result.cleanup.token_file_removed, true);
  assert.doesNotMatch(harness.resultJson, new RegExp(escapeRegExp(os.homedir())));
});

test('cleanup refuses to overwrite a changed fixture prefix and token file', async (t) => {
  const harness = makeHarness({ changeFixturePrefixAtSpawn: true });
  t.after(() => removeTestOutput(harness.output.absolute));

  const result = await harness.run();

  assert.equal(result.success, false);
  assert.equal(result.failure_stage, 'cleanup');
  assert.equal(result.failure_code, 'cleanup_incomplete');
  assert.equal(result.cleanup.server_stopped, true);
  assert.equal(result.cleanup.fixture_closed, true);
  assert.equal(result.cleanup.config_restored, false);
  assert.equal(result.cleanup.fixture_config_removed, false);
  assert.equal(result.cleanup.appended_config_preserved, false);
  assert.equal(result.cleanup.source_config_hash_unchanged, true);
  assert.equal(result.cleanup.token_file_removed, false);
  assert.equal(harness.spawnState.killCount, 1);
  assert.equal(fs.readFileSync(harness.fixturePaths.configPath, 'utf8'), harness.fixturePaths.editedPrefixConfig);
  assert.equal(fs.readFileSync(harness.spawnState.tokenPath, 'utf8'), 'PRIVATE_TOKEN_EDIT');
  assert.doesNotMatch(harness.resultJson, /node-edited|PRIVATE_TOKEN_EDIT/);
});

test('signals during startup and cleanup are recorded and all injected handlers are removed', async (t) => {
  const harness = makeHarness({ signalDuringStartup: true, signalDuringCleanup: true });
  t.after(() => removeTestOutput(harness.output.absolute));

  const result = await harness.run();

  assert.equal(result.success, false);
  assert.equal(result.failure_code, 'interrupted_by_signal');
  assert.equal(result.control_signal.requested, true);
  assert.equal(result.control_signal.signal, 'SIGINT');
  assert.equal(result.control_signal.count, 2);
  assert.equal(result.control_signal.during_cleanup, true);
  assert.equal(result.control_signal.handlers_removed, true);
  assert.equal(harness.spawnState.spawnCount, 0);
  assert.equal(result.cleanup.fixture_closed, true);
  assert.equal(result.cleanup.token_file_removed, true);
  assert.equal(harness.signalSource.listenerCount('SIGINT'), 0);
  assert.equal(harness.signalSource.listenerCount('SIGTERM'), 0);
});

test('pending turn success requires resolved approvals, cleared wait state, and the same completed turn', async (t) => {
  const harness = makeHarness({ pendingTurn: true, includeForeignLoadedThread: true });
  t.after(() => removeTestOutput(harness.output.absolute));

  const result = await harness.run();

  assert.equal(result.success, true);
  assert.equal(result.mode, 'pending_turn');
  assert.equal(result.pending.turn.approval_request_seen_a, true);
  assert.equal(result.pending.turn.same_turn_id, true);
  assert.equal(result.pending.turn.terminal_observed_by_both, true);
  assert.equal(result.pending.turn.status_a, 'completed');
  assert.equal(result.pending.turn.status_b, 'completed');
  assert.equal(result.pending.request_after_cli.correlation.approval_resolution_correlation_complete, true);
  assert.equal(result.pending.waiting_on_approval_transition_observed, true);
  assert.equal(result.pending.request_after_cli.a.waiting_on_approval_active, false);
  assert.equal(result.pending.request_after_cli.b.waiting_on_approval_seen, false);
  assert.equal(result.pending.request_after_cli.b.waiting_on_approval_cleared, false);
  assert.equal(result.server_requests.answered_by_runner, false);
  assert.deepEqual(harness.lifecycleCalls(), [
    ['a', 'turn/start'],
    ['b', 'thread/resume'],
  ]);
  assert.equal(harness.calls.find((call) => call.method === 'thread/start').params.approvalPolicy, 'untrusted');
  assert.ok(harness.calls.every((call) => JSON_RPC_METHODS.includes(call.method)));
  assert.equal(harness.calls.some((call) => /approval|permission|serverRequest/i.test(call.method)), false);

  for (const side of ['a', 'b']) {
    const summary = result.pending.additional_loaded_threads[side];
    assert.equal(summary.extra_count, 1);
    assert.equal(summary.read_match_count, 1);
    assert.equal(summary.source_kind_counts.subAgent, 1);
    assert.equal(summary.status_counts.idle, 1);
    assert.equal(summary.all_parent_matches_target, true);
    assert.equal(summary.all_turns_omitted, false);
  }
  assert.doesNotMatch(harness.resultJson, /PRIVATE_FOREIGN|PRIVATE_PENDING|request-approval-42/);
  assert.equal(harness.resultJson.includes(FOREIGN_THREAD_ID), false);
  assert.equal(harness.resultJson.includes(harness.tokenValue), false);

  const waitingAgain = structuredClone(result);
  waitingAgain.pending.request_after_cli.a.waiting_on_approval_active = true;
  waitingAgain.pending.waiting_on_approval_transition_observed = false;
  assert.equal(buildPendingSuccess(waitingAgain), false);
  const unresolvedApproval = structuredClone(result);
  unresolvedApproval.pending.request_after_cli.correlation.approval_resolution_correlation_complete = false;
  assert.equal(buildPendingSuccess(unresolvedApproval), false);
  const mismatchedTerminalStatus = structuredClone(result);
  mismatchedTerminalStatus.pending.turn.status_b = 'interrupted';
  assert.equal(buildPendingSuccess(mismatchedTerminalStatus), false);
  const differentTurn = structuredClone(result);
  differentTurn.pending.turn.same_turn_id = false;
  assert.equal(buildPendingSuccess(differentTurn), false);
});

test('pending cancel succeeds when both clients observe the same interrupted terminal turn', async (t) => {
  const harness = makeHarness({
    pendingTurn: true,
    pendingStatusA: 'interrupted',
    pendingStatusB: 'interrupted',
  });
  t.after(() => removeTestOutput(harness.output.absolute));

  const result = await harness.run();

  assert.equal(result.success, true);
  assert.equal(result.pending.turn.same_turn_id, true);
  assert.equal(result.pending.turn.terminal_observed_by_both, true);
  assert.equal(result.pending.turn.status_a, 'interrupted');
  assert.equal(result.pending.turn.status_b, 'interrupted');
  assert.equal(result.pending.request_after_cli.correlation.approval_resolution_correlation_complete, true);
  assert.equal(result.pending.waiting_on_approval_transition_observed, true);
  assert.equal(result.pending.settlement_observed, true);
});

test('pending success waits for both clients to observe a delayed approval-clear notification', async (t) => {
  const harness = makeHarness({ pendingTurn: true, pendingOutcome: 'delayed_clear' });
  t.after(() => removeTestOutput(harness.output.absolute));

  const result = await harness.run();

  assert.equal(result.success, true);
  assert.equal(result.pending.request_after_cli.a.waiting_on_approval_seen, true);
  assert.equal(result.pending.request_after_cli.a.waiting_on_approval_active, false);
  assert.equal(result.pending.request_after_cli.b.waiting_on_approval_seen, true);
  assert.equal(result.pending.request_after_cli.b.waiting_on_approval_cleared, true);
  assert.equal(result.pending.request_after_cli.b.waiting_on_approval_active, false);
  assert.equal(result.pending.settlement_observed, true);
});

test('matching failed terminal statuses are observed but never count as pending success', async (t) => {
  const harness = makeHarness({
    pendingTurn: true,
    pendingStatusA: 'failed',
    pendingStatusB: 'failed',
  });
  t.after(() => removeTestOutput(harness.output.absolute));

  const result = await harness.run();

  assert.equal(result.pending.turn.terminal_observed_by_both, true);
  assert.equal(result.pending.turn.status_a, 'failed');
  assert.equal(result.pending.turn.status_b, 'failed');
  assert.equal(result.pending.settlement_observed, true);
  assert.equal(result.success, false);
  assert.equal(buildPendingSuccess(result), false);
});

test('pending run remains unsuccessful when approval, wait state, or terminal status is inconsistent', async (t) => {
  const scenarios = [
    { resolvedRequestId: 'unmatched-request' },
    { pendingOutcome: 'waiting_again' },
    { pendingOutcome: 'b_still_active' },
    { pendingStatusB: 'failed' },
  ];

  for (const scenario of scenarios) {
    const harness = makeHarness({ pendingTurn: true, ...scenario });
    t.after(() => removeTestOutput(harness.output.absolute));
    const result = await harness.run();

    assert.equal(result.success, false);
    assert.equal(buildPendingSuccess(result), false);
  }
});

test('pending approval correlation deduplicates resolutions and distinguishes numeric and string IDs', () => {
  const observerA = createClientObserver();
  const observerB = createClientObserver();
  observerA.onServerRequest({ id: 42, method: 'item/permissions/requestApproval' });
  observerA.onServerRequest({ id: '42', method: 'item/permissions/requestApproval' });
  observerA.onNotification('serverRequest/resolved', { threadId: THREAD_ID, requestId: 42 });
  observerA.onNotification('serverRequest/resolved', { threadId: THREAD_ID, requestId: 42 });
  observerA.onNotification('serverRequest/resolved', { threadId: THREAD_ID, requestId: '42' });
  observerB.onNotification('serverRequest/resolved', { threadId: THREAD_ID, requestId: '42' });
  observerB.onNotification('serverRequest/resolved', { threadId: THREAD_ID, requestId: 'unmatched-request' });

  const correlation = summarizeServerRequestCorrelation([observerA, observerB]);

  assert.deepEqual(correlation, {
    unique_request_id_count: 2,
    unique_approval_request_id_count: 2,
    unique_resolved_request_id_count: 2,
    resolved_approval_request_id_count: 2,
    unresolved_approval_request_id_count: 0,
    unmatched_resolved_request_id_count: 0,
    approval_resolution_correlation_complete: true,
  });
  assert.equal(observerB.requestSummary().unmatched_resolution_count, 2);
  assert.doesNotMatch(JSON.stringify(correlation), /42|unmatched-request/);
});

test('pending mode keeps loaded thread identifiers and response bodies out of its result summary', async (t) => {
  const loadedSnapshot = await inspectAdditionalLoadedThreads({
    async request(method, params) {
      if (method === 'thread/loaded/list') {
        return { data: [THREAD_ID, FOREIGN_THREAD_ID], nextCursor: null };
      }
      assert.equal(method, 'thread/read');
      assert.equal(params.threadId, FOREIGN_THREAD_ID);
      assert.equal(params.includeTurns, false);
      return {
        thread: {
          id: FOREIGN_THREAD_ID,
          source: { subAgent: { parentThreadId: THREAD_ID } },
          status: { type: 'idle' },
          title: 'PRIVATE_FOREIGN_TITLE',
          preview: 'PRIVATE_FOREIGN_PREVIEW',
          turns: [{ text: 'PRIVATE_FOREIGN_TURN_BODY' }],
        },
      };
    },
  }, THREAD_ID);

  assert.equal(loadedSnapshot.target_loaded, true);
  assert.equal(loadedSnapshot.extra_count, 1);
  assert.equal(loadedSnapshot.read_match_count, 1);
  assert.equal(loadedSnapshot.status_counts.idle, 1);
  assert.equal(loadedSnapshot.all_turns_omitted, false);
  assert.doesNotMatch(JSON.stringify(loadedSnapshot), /PRIVATE|d5f9a620-c90b-463e-97f5-2105fcb5f26c/);
});

function makeHarness(scenario = {}) {
  const output = makeOutputPath();
  const layout = makeSourceLayout(output.absolute);
  const fixturePaths = makeFixtureHome(output.absolute);
  const tokenBytes = Buffer.alloc(32, 0x5a);
  const tokenValue = tokenBytes.toString('hex');
  const calls = [];
  const connectedObservers = [];
  const connectedOptions = [];
  const spawnState = { spawnCount: 0, killCount: 0, tokenPath: null };
  const signalSource = new EventEmitter();
  const childProcesses = [];
  let startedFixture;
  let resultJson = '';
  const fakeCodexPath = path.join(output.absolute, 'fake-codex.exe');
  fs.writeFileSync(fakeCodexPath, 'test fixture executable');

  const dependencies = {
    prepareWorkspace: () => layout,
    startFixture: async (_output, _codexPath, options) => {
      assert.equal(options.startWith, scenario.pendingTurn ? 'command' : 'mcp');
      if (scenario.signalDuringStartup) signalSource.emit('SIGINT');
      const fixture = {
        requests: [],
        unsupported: false,
        async close() {
          fixture.closed = true;
          if (scenario.signalDuringCleanup) signalSource.emit('SIGTERM');
          return true;
        },
        closed: false,
      };
      startedFixture = {
        layout,
        isolatedHome: scenario.escapedRuntimeHome || fixturePaths.home,
        fixture,
        version: { version: CODEX_VERSION },
        configPath: fixturePaths.configPath,
        configSnapshot: fixturePaths.configSnapshot,
      };
      return startedFixture;
    },
    spawn: (executable, args, spawnOptions) => {
      spawnState.spawnCount += 1;
      assert.equal(executable, fakeCodexPath);
      assert.equal(spawnOptions.cwd, layout.repo);
      assert.equal(spawnOptions.windowsHide, true);
      spawnState.tokenPath = args[args.indexOf('--ws-token-file') + 1];
      if (scenario.appendNativeConfigSuffixAtSpawn) {
        fs.appendFileSync(fixturePaths.configPath, NATIVE_CONFIG_SUFFIX);
      }
      if (scenario.changeFixturePrefixAtSpawn) {
        fs.writeFileSync(fixturePaths.configPath, fixturePaths.editedPrefixConfig);
        fs.writeFileSync(spawnState.tokenPath, 'PRIVATE_TOKEN_EDIT');
      }
      const child = new EventEmitter();
      child.stderr = new PassThrough();
      childProcesses.push(child);
      child.kill = () => {
        spawnState.killCount += 1;
        setImmediate(() => child.emit('close', 0, null));
        return true;
      };
      return child;
    },
    connect: async (options) => {
      assert.equal(options.host, '127.0.0.1');
      assert.match(options.capabilityToken, /^[0-9a-f]{64}$/);
      const connectionIndex = connectedObservers.length;
      const label = ['a', 'b', 'reconnect'][connectionIndex];
      connectedObservers.push(options.onNotification);
      connectedOptions.push(options);
      let turnStartCount = 0;
      const connection = {
        client: {
          async request(method, params) {
            calls.push({ label, method, params });
            if (method === 'initialize') {
              return {
                codexHome: fixturePaths.home,
                platformFamily: 'windows',
                platformOs: 'windows',
                userAgent: 'codex_cli/0.160.0',
              };
            }
            if (method === 'thread/start') {
              return effectiveThread(THREAD_ID, layout.repo, scenario.pendingTurn ? 'untrusted' : 'on-request');
            }
            if (method === 'thread/resume') {
              if (scenario.resumeRpcFailure) {
                const error = new PocError('rpc_error', {
                  rpcCode: -32600,
                  rpcErrorCategory: 'resume_unavailable',
                });
                error.rawMessage = 'PRIVATE_RPC_ERROR resume denied';
                throw error;
              }
              if (scenario.pendingTurn) {
                options.onServerRequest?.({ id: PENDING_REQUEST_ID, method: 'item/permissions/requestApproval' });
                if (['b_still_active', 'delayed_clear'].includes(scenario.pendingOutcome) && label === 'b') {
                  options.onNotification?.('thread/status/changed', {
                    threadId: THREAD_ID,
                    threadStatus: { type: 'active', activeFlags: ['waitingOnApproval'] },
                  });
                }
              }
              return effectiveThread(THREAD_ID, layout.repo, scenario.pendingTurn ? 'untrusted' : 'on-request');
            }
            if (method === 'thread/loaded/list') {
              return {
                data: scenario.includeForeignLoadedThread ? [THREAD_ID, FOREIGN_THREAD_ID] : [THREAD_ID],
                nextCursor: null,
              };
            }
            if (method === 'thread/read') {
              if (params.threadId === FOREIGN_THREAD_ID) {
                return {
                  thread: {
                    id: FOREIGN_THREAD_ID,
                    source: { subAgent: { parentThreadId: THREAD_ID } },
                    status: { type: 'idle' },
                    title: 'PRIVATE_FOREIGN_TITLE',
                    preview: 'PRIVATE_FOREIGN_PREVIEW',
                    turns: [{ text: 'PRIVATE_FOREIGN_TURN_BODY' }],
                  },
                };
              }
              return { thread: { id: THREAD_ID, status: { type: 'active' }, turns: [] } };
            }
            if (method === 'turn/start') {
              if (scenario.pendingTurn) {
                options.onServerRequest?.({ id: PENDING_REQUEST_ID, method: 'item/permissions/requestApproval' });
                options.onNotification?.('turn/started', {
                  threadId: THREAD_ID,
                  turnId: PENDING_TURN_ID,
                  status: 'inProgress',
                });
                options.onNotification?.('thread/status/changed', {
                  threadId: THREAD_ID,
                  threadStatus: { type: 'active', activeFlags: ['waitingOnApproval'] },
                });
                return { turn: { id: PENDING_TURN_ID, status: 'inProgress' } };
              }
              turnStartCount += 1;
              const turnId = label === 'a' && turnStartCount === 1 ? WARMUP_TURN_ID : OBSERVED_TURN_ID;
              if (label === 'a' && turnStartCount === 1) {
                startedFixture.fixture.requests.push({}, {}, {});
              }
              const notifyTurn = (observer, status) => {
                observer?.('turn/started', { threadId: THREAD_ID, turnId, status: 'inProgress' });
                observer?.('turn/completed', { threadId: THREAD_ID, turnId, status });
              };
              notifyTurn(options.onNotification, 'completed');
              if (label === 'a' && turnStartCount === 2) {
                notifyTurn(connectedObservers[1], scenario.observedStatusB || 'completed');
              }
              return { turn: { id: turnId, status: 'inProgress' } };
            }
            throw new Error('unexpected_fake_rpc_method');
          },
          async notify(method, params) {
            calls.push({ label, method, params });
          },
        },
        close() { connection.closed = true; },
        closed: false,
      };
      return connection;
    },
    chooseLoopbackPort: async () => 49231,
    randomBytes: () => tokenBytes,
    signalSource,
    waitForStopSignal: scenario.pendingTurn
      ? async () => {
        const emitCliEvents = (sendTerminalTurn) => {
          for (const options of connectedOptions) {
            if (scenario.pendingOutcome !== 'unresolved') {
              options.onNotification?.('serverRequest/resolved', {
                threadId: THREAD_ID,
                requestId: scenario.resolvedRequestId || PENDING_REQUEST_ID,
              });
            }
            const bRemainsActive = scenario.pendingOutcome === 'b_still_active'
              && options === connectedOptions[1];
            if (scenario.pendingOutcome !== 'keep_waiting' && !bRemainsActive
              && scenario.pendingOutcome !== 'delayed_clear') {
              options.onNotification?.('thread/status/changed', {
                threadId: THREAD_ID,
                threadStatus: { type: 'active', activeFlags: [] },
              });
            }
            if (scenario.pendingOutcome === 'waiting_again') {
              options.onNotification?.('thread/status/changed', {
                threadId: THREAD_ID,
                threadStatus: { type: 'active', activeFlags: ['waitingOnApproval'] },
              });
            }
            if (sendTerminalTurn) {
              options.onNotification?.('turn/completed', {
                threadId: THREAD_ID,
                turnId: options === connectedOptions[1] && scenario.pendingTurnIdB
                  ? scenario.pendingTurnIdB
                  : PENDING_TURN_ID,
                status: options === connectedOptions[1]
                  ? scenario.pendingStatusB || 'completed'
                  : scenario.pendingStatusA || 'completed',
              });
            }
          }
        };
        if (scenario.pendingOutcome === 'delayed_clear') {
          emitCliEvents(true);
          setTimeout(() => {
            for (const options of connectedOptions) {
              options.onNotification?.('thread/status/changed', {
                threadId: THREAD_ID,
                threadStatus: { type: 'active', activeFlags: [] },
              });
            }
          }, 50);
        } else {
          emitCliEvents(true);
        }
        return 'SIGINT';
      }
      : undefined,
    writeResult: (_output, result) => {
      resultJson = JSON.stringify(result);
      return 'poc/out/injected-managed-result.json';
    },
  };

  return {
    output,
    calls,
    spawnState,
    signalSource,
    fixturePaths,
    tokenValue,
    get resultJson() { return resultJson; },
    lifecycleCalls() {
      return calls.filter((call) => ['turn/start', 'thread/resume'].includes(call.method))
        .map((call) => [call.label, call.method]);
    },
    async run() {
      return runManagedServer({
        codexPath: fakeCodexPath,
        outputDirectory: output.relative,
        timeoutMs: 1000,
        servePendingTurn: scenario.pendingTurn === true,
      }, dependencies);
    },
  };
}

function effectiveThread(threadId, cwd, approvalPolicy = 'on-request') {
  return {
    thread: { id: threadId, ephemeral: false },
    cwd,
    approvalPolicy,
    model: FIXTURE_MODEL,
    modelProvider: 'poc157_fixture',
    sandbox: { type: 'readOnly', networkAccess: false },
  };
}

function makeOutputPath() {
  const relative = path.join('poc', 'out', 'managed-test-' + randomUUID());
  return { relative, absolute: path.resolve(REPOSITORY_ROOT, relative) };
}

function makeSourceLayout(output) {
  const layout = makeLayout(output);
  fs.mkdirSync(layout.home, { recursive: true });
  fs.mkdirSync(layout.repo, { recursive: true });
  fs.writeFileSync(path.join(layout.home, 'config.toml'), '[mcp_servers.source]\n');
  return layout;
}

function makeFixtureHome(output) {
  const home = path.join(output, 'runtime-homes', '01a10d78-8654-4e12-bfc7-7b5ea0d548b1');
  fs.mkdirSync(home, { recursive: true });
  const configPath = path.join(home, 'config.toml');
  const originalConfig = 'model = "existing-test-model"\n';
  const appliedConfig = originalConfig + '\n[mcp_servers.fixture]\ncommand = "node"\nargs = ["probe"]\n';
  const editedPrefixConfig = appliedConfig.replace('command = "node"', 'command = "node-edited"');
  fs.writeFileSync(configPath, appliedConfig);
  return {
    home,
    configPath,
    originalConfig,
    appliedConfig,
    editedPrefixConfig,
    configSnapshot: {
      output,
      isolatedHome: home,
      configPath,
      originalConfig,
      appliedConfig,
    },
  };
}

function removeTestOutput(output) {
  const outputBase = path.resolve(REPOSITORY_ROOT, 'poc', 'out');
  const resolved = path.resolve(output);
  const relative = path.relative(outputBase, resolved);
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
