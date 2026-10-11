'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildScenarios,
  countState,
  createReadRouteHarness,
  createScenarioFixture,
  createTemporaryRoot,
  instrumentLookups,
  main,
  parseArgs,
  run,
  validateWorkBudget,
} = require('../tools/manual/projection-display-baseline');

test('bounded arguments reject malformed and over-budget values before fixture construction', () => {
  for (const argv of [
    ['--samples', '0'],
    ['--sessions', '-1'],
    ['--tombstones', '1e3'],
    ['--churn', '10001'],
    ['--sessions', '1', '--sessions', '2'],
    ['--unknown'],
    ['--help', '--samples', '1'],
  ]) {
    assert.throws(() => parseArgs(argv));
  }

  const oversized = parseArgs([
    '--sweep', 'tombstones', '--tombstones', '10000', '--sessions', '2000',
    '--projections', '10000', '--samples', '25', '--warmup', '5',
  ]);
  assert.throws(() => validateWorkBudget(oversized), /estimated legacy full-scan visit budget/);
});

test('provider scenarios count N as total records and keep unknown provenance out of provider values', async () => {
  const options = parseArgs([
    '--sweep', 'providers', '--fixed-tombstones', '3', '--sessions', '2',
    '--projections', '2', '--samples', '1', '--warmup', '0', '--churn', '2',
  ]);
  assert.deepEqual(buildScenarios(options).map((scenario) => scenario.providerMode), [
    'claude', 'codex', 'both', 'unknown',
  ]);

  const result = await run(options);
  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(result.measurementModel, {
    name: 'session-index',
    lookupCalls: 'observed',
    returnedRecords: 'observed',
    bucketVisits: 'not-observed',
  });
  assert.equal(result.scenarios.length, 4);
  const routeExpectations = {
    claude: { sessions: 1, questions: 1, instructions: 0, lookupCalls: 4, returnedRecords: 4 },
    codex: { sessions: 1, questions: 1, instructions: 0, lookupCalls: 4, returnedRecords: 4 },
    both: { sessions: 2, questions: 0, instructions: 0, lookupCalls: 2, returnedRecords: 2 },
    unknown: { sessions: 1, questions: 0, instructions: 0, lookupCalls: 3, returnedRecords: 3 },
  };
  for (const scenario of result.scenarios) {
    assert.equal(scenario.counts.inputRecordCount, 3);
    assert.equal(scenario.counts.restoredMapSize, 3);
    assert.equal(scenario.counts.tombstoneRecordCount, 3);
    assert.equal(scenario.counts.restoredRecordCount, 3);
    assert.equal(scenario.counts.activeSessionCount, 2);
    assert.equal(scenario.counts.sourceHistoryRows, 0);
    const expectedRoute = routeExpectations[scenario.fixture.providerMode];
    assert.equal(scenario.counts.routeSessionCount, expectedRoute.sessions);
    assert.equal(scenario.counts.routeProjectionCounts.questions, expectedRoute.questions);
    assert.equal(scenario.counts.routeProjectionCounts.instructions, expectedRoute.instructions);
    assert.equal(scenario.counts.lookupCallsMeasured, expectedRoute.lookupCalls);
    assert.equal(scenario.counts.lookupRecordsReturnedMeasured, expectedRoute.returnedRecords);
    assert.equal(scenario.fixture.lookupBatchSize, expectedRoute.lookupCalls);
    assert.equal(
      scenario.counts.recordsByProvider.claude + scenario.counts.recordsByProvider.codex,
      scenario.counts.inputRecordCount,
    );
    assert.ok(scenario.counts.storeJsonUtf8Bytes > scenario.counts.projectionDisplayJsonUtf8Bytes);
    assert.ok(scenario.counts.stateRouteJsonUtf8Bytes > 0);
    for (const phase of Object.values(scenario.timings)) {
      assert.equal(phase.sampleCount, 1);
      assert.equal(phase.warmupCount, 0);
      assert.equal(phase.p95IsLowSampleReference, true);
      assert.ok(Number.isFinite(phase.medianMs));
      assert.ok(Number.isFinite(phase.p95Ms));
      assert.ok(Number.isFinite(phase.maxMs));
      assert.ok(0 <= phase.medianMs && phase.medianMs <= phase.p95Ms && phase.p95Ms <= phase.maxMs);
    }
  }

  const both = result.scenarios.find((scenario) => scenario.fixture.providerMode === 'both');
  assert.deepEqual(both.fixture.recordComposition, {
    totalRecords: 3,
    sameSessionClaudeCodexPairs: 1,
    singleProviderRemainder: 1,
  });
  assert.deepEqual(both.counts.recordsByProvider, { claude: 2, codex: 1 });
  assert.equal(both.counts.distinctRecordSessions, 2);

  const unknown = result.scenarios.find((scenario) => scenario.fixture.providerMode === 'unknown');
  assert.ok(unknown.counts.unknownSourceIds > 0);
  assert.deepEqual(unknown.counts.recordsByProvider, { claude: 3, codex: 0 });
});

test('CLI keeps argument diagnostics and redacts arbitrary runtime errors', async () => {
  const stdout = { value: '', write(chunk) { this.value += chunk; } };
  const stderr = { value: '', write(chunk) { this.value += chunk; } };
  const privatePath = 'C:\\temp\\projection-display-baseline-private\\store.json';
  const exitCode = await main([
    '--sweep', 'tombstones', '--tombstones', '0', '--sessions', '1',
    '--projections', '1', '--samples', '1', '--warmup', '0',
  ], {
    stdout,
    stderr,
    run: async () => { throw new Error(`filesystem failure at ${privatePath}`); },
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout.value, '');
  assert.equal(stderr.value, 'projection-display-baseline: measurement failed\n');
  assert.ok(!stderr.value.includes(privatePath));

  const argumentError = { value: '', write(chunk) { this.value += chunk; } };
  const argumentExit = await main([privatePath], {
    stdout: { write() {} },
    stderr: argumentError,
  });
  assert.equal(argumentExit, 1);
  assert.equal(argumentError.value, 'projection-display-baseline: unknown option\n');
  assert.ok(!argumentError.value.includes(privatePath));

  const budgetError = { value: '', write(chunk) { this.value += chunk; } };
  const budgetExit = await main([
    '--sweep', 'tombstones', '--tombstones', '10000', '--sessions', '2000',
    '--projections', '10000', '--samples', '25', '--warmup', '5',
  ], {
    stdout: { write() {} },
    stderr: budgetError,
    run: async () => { throw new Error('budget validation must precede measurement'); },
  });
  assert.equal(budgetExit, 1);
  assert.match(budgetError.value, /estimated legacy full-scan visit budget/);
});

test('canonical store order restores without scheduling normalization writes', async () => {
  const temporary = await createTemporaryRoot();
  try {
    const longOptions = parseArgs([
      '--sweep', 'tombstones', '--tombstones', '11', '--sessions', '2',
      '--projections', '0', '--samples', '1', '--warmup', '0', '--provider-mode', 'claude',
    ]);
    const [longScenario] = buildScenarios(longOptions);
    const longFixture = await createScenarioFixture(longScenario, temporary.root);
    const longRecords = JSON.parse(longFixture.storeJson).projectionDisplaySettings;
    const historyTenIndex = longRecords.findIndex((record) => record.session_id.endsWith('history-10'));
    const historyEightIndex = longRecords.findIndex((record) => record.session_id.endsWith('history-8'));
    assert.ok(historyTenIndex >= 0 && historyEightIndex >= 0);
    assert.ok(historyTenIndex < historyEightIndex);
    assert.equal(longFixture.filesystemCalls.writerWrites, 0);
    assert.equal(longFixture.state.storeWritePending, false);
    assert.equal(longFixture.filesystemCalls.rename, 0);
    assert.deepEqual(longFixture.filesystemCalls.rejected, []);

    const pairOptions = parseArgs([
      '--sweep', 'tombstones', '--tombstones', '6', '--sessions', '2',
      '--projections', '0', '--samples', '1', '--warmup', '0', '--provider-mode', 'both',
    ]);
    const [pairScenario] = buildScenarios(pairOptions);
    const pairFixture = await createScenarioFixture(pairScenario, temporary.root);
    const pairRecords = JSON.parse(pairFixture.storeJson).projectionDisplaySettings;
    const claudeSessionIds = pairRecords.filter((record) => record.provider === 'claude')
      .map((record) => record.session_id);
    const codexSessionIds = pairRecords.filter((record) => record.provider === 'codex')
      .map((record) => record.session_id);
    assert.deepEqual(pairRecords.map((record) => record.provider), [
      'claude', 'claude', 'claude', 'codex', 'codex', 'codex',
    ]);
    assert.equal(new Set(claudeSessionIds).size, 3);
    assert.deepEqual(claudeSessionIds, codexSessionIds);
    assert.equal(pairFixture.filesystemCalls.writerWrites, 0);
    assert.equal(pairFixture.state.storeWritePending, false);
    assert.equal(pairFixture.filesystemCalls.rename, 0);
    assert.deepEqual(pairFixture.filesystemCalls.rejected, []);
  } finally {
    await temporary.cleanup();
  }
});

test('churn retains active and historical provenance counts as separate rows', async () => {
  const options = parseArgs([
    '--sweep', 'churn', '--fixed-tombstones', '1', '--sessions', '2',
    '--projections', '0', '--samples', '1', '--warmup', '0', '--churn', '2',
  ]);
  const [scenario] = (await run(options)).scenarios;
  assert.equal(scenario.counts.activeSessionCount, 2);
  assert.equal(scenario.counts.sourceHistoryRows, 2);
  assert.equal(scenario.counts.sourceMapKeys, 4);
  assert.equal(scenario.counts.sourceProviderElements, 4);
  assert.equal(scenario.fixture.churn, 2);
});

test('diagnostic count snapshots leave observed lookup metrics unchanged', async () => {
  const options = parseArgs([
    '--sweep', 'tombstones', '--tombstones', '1', '--sessions', '1',
    '--projections', '2', '--samples', '1', '--warmup', '0', '--provider-mode', 'claude',
  ]);
  const [scenario] = buildScenarios(options);
  const temporary = await createTemporaryRoot();
  try {
    const fixture = await createScenarioFixture(scenario, temporary.root);
    assert.equal(fixture.filesystemCalls.readFile, 1);
    assert.equal(fixture.filesystemCalls.rename, 0);
    assert.deepEqual(fixture.filesystemCalls.rejected, []);

    const counter = instrumentLookups(fixture.state);
    const routeResult = await createReadRouteHarness(
      fixture.state,
      fixture.projections,
      temporary.webPath,
    ).readState();
    const routeMetrics = { ...counter.metrics };
    countState(fixture.state, routeResult, {
      ...routeMetrics,
      inputRecordCount: fixture.records.length,
      projections: fixture.projections,
    });
    assert.deepEqual(counter.metrics, routeMetrics);
    assert.ok(routeMetrics.lookupCalls > 0);
    assert.ok(routeMetrics.lookupRecordsReturned > 0);
    counter.stop();
    const afterStop = { ...counter.metrics };
    const targetRecord = fixture.records[0];
    assert.deepEqual(
      fixture.state.projectionDisplayRecordsForSession(targetRecord.session_id),
      [targetRecord],
    );
    assert.deepEqual(counter.metrics, afterStop);

    const counts = countState(fixture.state, routeResult, {
      ...routeMetrics,
      inputRecordCount: fixture.records.length,
      projections: fixture.projections,
    });
    assert.deepEqual(counter.metrics, afterStop);
    assert.equal(counts.lookupCallsMeasured, routeMetrics.lookupCalls);
    assert.equal(counts.lookupRecordsReturnedMeasured, routeMetrics.lookupRecordsReturned);
    assert.equal(counts.routeSessionCount, 1);
    assert.deepEqual(counts.routeProjectionCounts, { questions: 1, instructions: 1 });
  } finally {
    await temporary.cleanup();
  }
});
