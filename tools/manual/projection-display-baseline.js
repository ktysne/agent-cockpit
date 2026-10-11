'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, realpath, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DashboardState } = require('../../src/server/state');
const { createReadRoutes } = require('../../src/server/routes/read');

const TEMP_PREFIX = 'projection-display-baseline-';
const FIXED_NOW = Date.parse('2026-10-01T00:00:00.000Z');
const FIXED_TIME = new Date(FIXED_NOW).toISOString();
const DEFAULT_OPTIONS = Object.freeze({
  sweep: 'all',
  tombstones: Object.freeze([0, 100, 1000, 10000]),
  fixedTombstones: 1000,
  sessions: 8,
  projections: 8,
  samples: 3,
  warmup: 1,
  seed: 312,
  providerMode: 'all',
  churn: 100,
});
const LIMITS = Object.freeze({
  tombstones: 10000,
  sessions: 2000,
  projections: 10000,
  samples: 25,
  warmup: 5,
  seed: 2147483647,
  churn: 10000,
  recordsPerScenario: 25000,
  totalFixtureRecords: 2000000,
  maxEstimatedLegacyFullScanVisits: 30000000,
});
const PROVIDER_MODES = Object.freeze(['claude', 'codex', 'both', 'unknown']);
const SWEEPS = Object.freeze(['all', 'tombstones', 'sessions', 'projections', 'providers', 'churn']);

function integerArgument(value, name, maximum, minimum = 0) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be a decimal integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside its safe limits`);
  }
  return parsed;
}

function parseTombstoneList(value) {
  const entries = value.split(',');
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
    throw new Error('--tombstones must be a comma-separated list of decimal integers');
  }
  const parsed = entries.map((entry) => integerArgument(entry, '--tombstones', LIMITS.tombstones));
  if (new Set(parsed).size !== parsed.length) throw new Error('--tombstones must not contain duplicates');
  return parsed.sort((left, right) => left - right);
}

function parseArgs(argv) {
  const options = {
    ...DEFAULT_OPTIONS,
    tombstones: [...DEFAULT_OPTIONS.tombstones],
    help: false,
  };
  const seen = new Set();
  const numericOptions = new Map([
    ['--fixed-tombstones', ['fixedTombstones', LIMITS.tombstones]],
    ['--sessions', ['sessions', LIMITS.sessions]],
    ['--projections', ['projections', LIMITS.projections]],
    ['--samples', ['samples', LIMITS.samples, 1]],
    ['--warmup', ['warmup', LIMITS.warmup]],
    ['--seed', ['seed', LIMITS.seed]],
    ['--churn', ['churn', LIMITS.churn]],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (seen.has(option)) throw new Error('duplicate options are not allowed');
    seen.add(option);
    if (option === '--help') {
      options.help = true;
      continue;
    }
    if (option === '--tombstones') {
      const value = argv[++index];
      if (value === undefined) throw new Error('--tombstones requires a value');
      options.tombstones = parseTombstoneList(value);
      continue;
    }
    if (numericOptions.has(option)) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${option} requires a value`);
      const [key, maximum, minimum] = numericOptions.get(option);
      options[key] = integerArgument(value, option, maximum, minimum);
      continue;
    }
    if (option === '--sweep') {
      const value = argv[++index];
      if (!SWEEPS.includes(value)) throw new Error('--sweep must be all, tombstones, sessions, projections, providers, or churn');
      options.sweep = value;
      continue;
    }
    if (option === '--provider-mode') {
      const value = argv[++index];
      if (value !== 'all' && !PROVIDER_MODES.includes(value)) {
        throw new Error('--provider-mode must be all, claude, codex, both, or unknown');
      }
      options.providerMode = value;
      continue;
    }
    throw new Error('unknown option');
  }

  if (options.help && argv.length !== 1) throw new Error('--help cannot be combined with other options');
  return options;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function defaultMode(options) {
  return options.providerMode === 'all' ? 'claude' : options.providerMode;
}

function buildScenarios(options) {
  const scenarios = [];
  const selected = (name) => options.sweep === 'all' || options.sweep === name;
  const mode = defaultMode(options);
  const base = { sessions: options.sessions, projections: options.projections, churn: 0 };
  const add = (sweep, values) => scenarios.push({ sweep, ...values });

  if (selected('tombstones')) {
    for (const tombstones of options.tombstones) add('tombstones', { ...base, tombstones, providerMode: mode });
  }
  if (selected('sessions')) {
    const values = uniqueSorted([1, options.sessions, Math.min(32, options.sessions * 4)]);
    for (const sessions of values) add('sessions', {
      ...base, sessions, tombstones: options.fixedTombstones, providerMode: mode,
    });
  }
  if (selected('projections')) {
    const values = uniqueSorted([0, options.projections, Math.min(32, options.projections * 4)]);
    for (const projections of values) add('projections', {
      ...base, projections, tombstones: options.fixedTombstones, providerMode: mode,
    });
  }
  if (selected('providers')) {
    const modes = options.providerMode === 'all' ? PROVIDER_MODES : [options.providerMode];
    for (const providerMode of modes) add('providers', {
      ...base,
      tombstones: Math.min(options.fixedTombstones, 100),
      providerMode,
    });
  }
  if (selected('churn')) add('churn', {
    ...base,
    tombstones: Math.min(options.fixedTombstones, 100),
    providerMode: 'unknown',
    churn: options.churn,
  });

  return scenarios.map((scenario) => ({
    ...scenario,
    seed: options.seed,
    id: `${scenario.sweep}:n${scenario.tombstones}:s${scenario.sessions}:p${scenario.projections}:${scenario.providerMode}:c${scenario.churn}`,
  }));
}

function validateWorkBudget(options, scenarios = buildScenarios(options)) {
  let totalFixtureRecords = 0;
  let estimatedLegacyFullScanVisits = 0;
  const fixtureBuildsPerScenario = (options.samples + options.warmup) * 2 + 2;
  const routeRunsPerScenario = options.samples + options.warmup + 2;

  for (const scenario of scenarios) {
    const recordCount = scenario.tombstones + scenario.sessions + scenario.projections + scenario.churn;
    if (recordCount > LIMITS.recordsPerScenario) throw new Error('scenario exceeds the per-fixture record limit');
    totalFixtureRecords += recordCount * fixtureBuildsPerScenario;
    const routeLookupCalls = scenario.sessions + scenario.projections;
    estimatedLegacyFullScanVisits += scenario.tombstones * (
      routeLookupCalls * routeRunsPerScenario +
      routeLookupCalls * (options.samples + options.warmup)
    );
  }

  if (totalFixtureRecords > LIMITS.totalFixtureRecords) throw new Error('run exceeds the total fixture construction limit');
  if (estimatedLegacyFullScanVisits > LIMITS.maxEstimatedLegacyFullScanVisits) {
    throw new Error('run exceeds the estimated legacy full-scan visit budget');
  }
  return { totalFixtureRecords, estimatedLegacyFullScanVisits };
}

function sessionId(seed, kind, index) {
  return `projection-baseline-${seed}-${kind}-${index}`;
}

function scenarioRecordIdentity(scenario, index) {
  if (scenario.providerMode === 'both' && index < scenario.tombstones - (scenario.tombstones % 2)) {
    const pairIndex = Math.floor(index / 2);
    const id = pairIndex < scenario.sessions
      ? sessionId(scenario.seed, 'active', pairIndex)
      : sessionId(scenario.seed, 'history-pair', pairIndex);
    return { id, provider: index % 2 === 0 ? 'claude' : 'codex' };
  }
  const activeIndex = scenario.sessions;
  const id = index < activeIndex
    ? sessionId(scenario.seed, 'active', index)
    : sessionId(scenario.seed, 'history', index);
  const provider = scenario.providerMode === 'codex' ? 'codex' : 'claude';
  return { id, provider };
}

function createDisplayRecords(scenario) {
  return Array.from({ length: scenario.tombstones }, (_, index) => {
    const identity = scenarioRecordIdentity(scenario, index);
    return index % 3 === 0
      ? { provider: identity.provider, session_id: identity.id, hiddenAt: FIXED_TIME }
      : { provider: identity.provider, session_id: identity.id, deletedAt: FIXED_TIME };
  });
}

function createProjectionRecords(scenario) {
  const questions = [];
  const instructions = [];
  for (let index = 0; index < scenario.projections; index += 1) {
    const sessionIndex = scenario.sessions === 0 ? index : index % scenario.sessions;
    const targetSessionId = scenario.sessions === 0
      ? sessionId(scenario.seed, 'projection-only', index)
      : sessionId(scenario.seed, 'active', sessionIndex);
    const provider = scenario.providerMode === 'codex'
      ? 'codex'
      : scenario.providerMode === 'both' && index % 2 === 1
        ? 'codex'
        : 'claude';
    if (index % 2 === 0) {
      questions.push({
        question: {
          identity: { nativeId: `baseline-question-${scenario.seed}-${index}` },
          createdAt: FIXED_TIME,
          internalQuestionId: `baseline-question-${scenario.seed}-${index}`,
        },
        link: { execution: { state: 'active', executionId: `baseline-execution-${scenario.seed}-${index}` } },
        provider,
        sessionId: targetSessionId,
      });
    } else {
      instructions.push({
        instruction: {
          identity: { nativeId: `baseline-instruction-${scenario.seed}-${index}` },
          launchRef: `baseline-launch-${scenario.seed}-${index}`,
        },
        link: { execution: { state: 'active', executionId: `baseline-execution-${scenario.seed}-${index}` } },
        provider,
        sessionId: targetSessionId,
      });
    }
  }
  return { questions, instructions, orphanedCommonQuestions: [], unmatchedInstructions: 0 };
}

function createStoreJson(records) {
  const store = new DashboardState().serializeStore();
  store.projectionDisplaySettings = records.map((record) => ({ ...record }))
    .sort((left, right) => `${left.provider}\0${left.session_id}`
      .localeCompare(`${right.provider}\0${right.session_id}`));
  return JSON.stringify(store);
}

function createMemoryFileSystem(homeDir, storeJson) {
  const calls = { readFile: 0, rename: 0, writerWrites: 0, rejected: [] };
  const storePath = path.resolve(homeDir, 'store.json');
  const operations = {
    async readFile(filePath, encoding) {
      calls.readFile += 1;
      if (path.resolve(filePath) !== storePath || encoding !== 'utf8') {
        calls.rejected.push('readFile');
        throw new Error('fixture filesystem rejected readFile');
      }
      return storeJson;
    },
    async rename() {
      calls.rename += 1;
      throw new Error('fixture filesystem rejected rename');
    },
  };
  const fileSystem = new Proxy(operations, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      calls.rejected.push(String(property));
      throw new Error('fixture filesystem rejected operation');
    },
  });
  return { fileSystem, calls };
}

function createWriter(calls) {
  return {
    async write(name) {
      calls.writerWrites = (calls.writerWrites || 0) + 1;
      if (name !== 'store.json') throw new Error('unexpected store writer target');
    },
    async flush() {},
  };
}

async function loadStateFromStoreJson(storeJson, fixtureRoot) {
  const homeDir = path.join(fixtureRoot, 'state');
  const memory = createMemoryFileSystem(homeDir, storeJson);
  const state = await DashboardState.load(homeDir, {
    fileSystem: memory.fileSystem,
    writer: createWriter(memory.calls),
    now: FIXED_NOW,
  });
  if (state.storeWritePending !== false || memory.calls.writerWrites !== 0) {
    throw new Error('store restore requested a normalization write');
  }
  await state.flushPersistence();
  if (state.storeWritePending !== false || memory.calls.writerWrites !== 0 || memory.calls.rename !== 0 ||
      memory.calls.rejected.length !== 0 || memory.calls.readFile !== 1) {
    throw new Error('store restore used an unexpected filesystem path or operation');
  }
  state.generatedAt = FIXED_TIME;
  state.version = 0;
  return { state, filesystemCalls: memory.calls };
}

function populateSessionSources(state, scenario) {
  const primaryProvider = scenario.providerMode === 'codex' ? 'codex' : 'claude';
  for (let index = 0; index < scenario.sessions; index += 1) {
    const id = sessionId(scenario.seed, 'active', index);
    state.sessions.set(id, {
      session_id: id,
      provider: primaryProvider,
      title: `active-session-${index}`,
      product: null,
      status: '待機中',
      tools: [],
      agents: [],
      permissionWaits: [],
      decisions: [],
    });
    const providers = scenario.providerMode === 'both'
      ? new Set(['claude', 'codex'])
      : new Set([primaryProvider]);
    state.sessionProviderSourcesById.set(id, providers);
    if (scenario.providerMode === 'unknown' && index % 2 === 0) state.unknownSessionProviderSourceIds.add(id);
  }
  for (let index = 0; index < scenario.churn; index += 1) {
    const id = sessionId(scenario.seed, 'source-history', index);
    state.sessionProviderSourcesById.set(id, new Set([index % 2 === 0 ? 'claude' : 'codex']));
    if (index % 4 === 0) state.unknownSessionProviderSourceIds.add(id);
  }
  state.generatedAt = FIXED_TIME;
  state.version = 0;
}

async function createScenarioFixture(scenario, fixtureRoot) {
  const records = createDisplayRecords(scenario);
  const storeJson = createStoreJson(records);
  const loaded = await loadStateFromStoreJson(storeJson, fixtureRoot);
  populateSessionSources(loaded.state, scenario);
  return {
    ...loaded,
    scenario,
    records,
    storeJson,
    projections: createProjectionRecords(scenario),
  };
}

function createResponseSink() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function createReadRouteHarness(state, projections, webPath) {
  const away = {
    snapshot: () => ({ enabled: false, since: null, periods: [] }),
    prune: () => undefined,
  };
  const routes = createReadRoutes({
    away,
    claudeHome: path.dirname(webPath),
    claudeIssuer: null,
    codexAgentScriptExists: async () => false,
    crossReviewToolExists: async () => false,
    dev: false,
    instructionService: null,
    instructionServiceReady: false,
    instructionTargetList: () => [],
    instructionTargetState: null,
    launchRegistry: null,
    managedCollectors: [],
    ownedExecutionSnapshot: null,
    providerEventProjection: { snapshot: () => ({}) },
    pullRequestTracker: { snapshot: () => [] },
    questionService: null,
    registrationSnapshotForInstructions: () => ({ conversations: [], executions: [] }),
    routing: { snapshot: () => ({ agents: 'default', review: 'default' }) },
    safeInstructionRecovery: () => null,
    state,
    userHome: path.dirname(webPath),
    validatedSessionProjectionRecords: () => projections,
    webPath,
  });

  async function readResponse() {
    const response = createResponseSink();
    await routes.handleState({ response });
    if (response.statusCode !== 200 || typeof response.body !== 'string') {
      throw new Error('state route did not return a JSON response');
    }
    return { statusCode: response.statusCode, json: response.body };
  }

  async function readState() {
    const response = await readResponse();
    return { statusCode: response.statusCode, body: JSON.parse(response.json), json: response.json };
  }

  return { readResponse, readState };
}

function instrumentLookups(state) {
  const metrics = { lookupCalls: 0, lookupRecordsReturned: 0 };
  const originalMethodDescriptor = Object.getOwnPropertyDescriptor(state, 'projectionDisplayRecordsForSession');
  const originalLookup = state.projectionDisplayRecordsForSession;

  Object.defineProperty(state, 'projectionDisplayRecordsForSession', {
    configurable: true,
    writable: true,
    value(sessionId) {
      metrics.lookupCalls += 1;
      const records = Reflect.apply(originalLookup, state, [sessionId]);
      if (!Array.isArray(records)) throw new Error('session lookup did not return an array');
      metrics.lookupRecordsReturned += records.length;
      return records;
    },
  });

  return {
    metrics,
    stop() {
      if (originalMethodDescriptor) Object.defineProperty(state, 'projectionDisplayRecordsForSession', originalMethodDescriptor);
      else delete state.projectionDisplayRecordsForSession;
    },
  };
}

function projectionCounts(projections) {
  return {
    questions: projections.questions.length,
    instructions: projections.instructions.length,
  };
}

function countState(state, routeResult, measured) {
  const diagnosticMap = state.projectionDisplaySettings;
  const records = [...diagnosticMap.values()];
  const mapSize = diagnosticMap.size;
  const store = state.serializeStore();
  const storeJson = JSON.stringify(store);
  const projectionJson = JSON.stringify(store.projectionDisplaySettings);
  const routeQuestions = routeResult.body.sessions.reduce((total, session) => total + (session.commonQuestions?.length || 0), 0);
  const routeInstructions = routeResult.body.sessions.reduce((total, session) => total + (session.instructions?.length || 0), 0);
  const sourceProviderElements = [...state.sessionProviderSourcesById.values()]
    .reduce((total, providers) => total + providers.size, 0);

  return {
    inputRecordCount: measured.inputRecordCount,
    restoredMapSize: mapSize,
    tombstoneRecordCount: mapSize,
    restoredRecordCount: records.length,
    recordsByState: {
      deletedAt: records.filter((record) => record.deletedAt !== undefined).length,
      hiddenAt: records.filter((record) => record.hiddenAt !== undefined).length,
    },
    recordsByProvider: {
      claude: records.filter((record) => record.provider === 'claude').length,
      codex: records.filter((record) => record.provider === 'codex').length,
    },
    distinctRecordSessions: new Set(records.map((record) => record.session_id)).size,
    sourceMapKeys: state.sessionProviderSourcesById.size,
    sourceProviderElements,
    unknownSourceIds: state.unknownSessionProviderSourceIds.size,
    stateSessionCount: state.sessions.size,
    activeSessionCount: state.sessions.size,
    sourceHistoryRows: state.sessionProviderSourcesById.size - state.sessions.size,
    activeDisplaySessionCount: routeResult.body.sessions.filter((session) => !session.hidden).length,
    routeSessionCount: routeResult.body.sessions.length,
    routeProjectionCounts: { questions: routeQuestions, instructions: routeInstructions },
    fixtureProjectionCounts: projectionCounts(measured.projections),
    lookupCallsMeasured: measured.lookupCalls,
    lookupRecordsReturnedMeasured: measured.lookupRecordsReturned,
    storeJsonUtf8Bytes: Buffer.byteLength(storeJson, 'utf8'),
    projectionDisplayJsonUtf8Bytes: Buffer.byteLength(projectionJson, 'utf8'),
    stateRouteJsonUtf8Bytes: Buffer.byteLength(routeResult.json, 'utf8'),
  };
}

function quantile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

async function measurePhase(operation, samples, warmup) {
  for (let index = 0; index < warmup; index += 1) await operation();
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    await operation();
    durations.push(performance.now() - startedAt);
  }
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    sampleCount: durations.length,
    warmupCount: warmup,
    p95IsLowSampleReference: durations.length < 20,
    medianMs: Number(quantile(sorted, 0.5).toFixed(3)),
    p95Ms: Number(quantile(sorted, 0.95).toFixed(3)),
    maxMs: Number(sorted.at(-1).toFixed(3)),
  };
}

function lookupTargets(scenario, count) {
  return Array.from({ length: count }, (_, index) => scenario.sessions === 0
    ? sessionId(scenario.seed, 'projection-only', index % Math.max(1, scenario.projections))
    : sessionId(scenario.seed, 'active', index % scenario.sessions));
}

async function measureScenario(scenario, options, fixtureRoot, webPath) {
  const countFixture = await createScenarioFixture(scenario, fixtureRoot);
  const counter = instrumentLookups(countFixture.state);
  const countHarness = createReadRouteHarness(countFixture.state, countFixture.projections, webPath);
  const countRouteResult = await countHarness.readState();
  const countMetrics = {
    ...counter.metrics,
    inputRecordCount: countFixture.records.length,
    projections: countFixture.projections,
  };
  counter.stop();
  const counts = countState(countFixture.state, countRouteResult, countMetrics);
  if (counts.lookupCallsMeasured > scenario.sessions + scenario.projections) {
    throw new Error('route lookup calls exceed the scenario work estimate');
  }

  const construction = await measurePhase(async () => {
    await createScenarioFixture(scenario, fixtureRoot);
  }, options.samples, options.warmup);
  const timingFixture = await createScenarioFixture(scenario, fixtureRoot);
  if (timingFixture.state.serializeStore().projectionDisplaySettings.length !== counts.restoredRecordCount) {
    throw new Error('timing fixture record count differs from the count fixture');
  }
  const harness = createReadRouteHarness(timingFixture.state, timingFixture.projections, webPath);
  await harness.readState();
  const lookupBatchSize = counts.lookupCallsMeasured;
  const lookups = lookupTargets(scenario, lookupBatchSize);
  const storeValue = timingFixture.state.serializeStore();
  const stateBeforeTiming = {
    canonicalStoreJson: JSON.stringify(storeValue),
    version: timingFixture.state.version,
    displayMapSize: timingFixture.state.projectionDisplaySettings.size,
  };

  const timings = {
    fixtureConstruction: construction,
    lookupBatch: await measurePhase(() => {
      for (const id of lookups) timingFixture.state.projectionDisplayRecordsForSession(id);
    }, options.samples, options.warmup),
    stateSnapshot: await measurePhase(() => timingFixture.state.snapshot(), options.samples, options.warmup),
    stateRouteAndResponseJson: await measurePhase(() => harness.readResponse(), options.samples, options.warmup),
    serializeStore: await measurePhase(() => timingFixture.state.serializeStore(), options.samples, options.warmup),
    storeJsonStringify: await measurePhase(() => JSON.stringify(storeValue), options.samples, options.warmup),
    storeLoadNormalizeRestore: await measurePhase(
      () => loadStateFromStoreJson(timingFixture.storeJson, fixtureRoot), options.samples, options.warmup),
  };
  const stateAfterTiming = {
    canonicalStoreJson: JSON.stringify(timingFixture.state.serializeStore()),
    version: timingFixture.state.version,
    displayMapSize: timingFixture.state.projectionDisplaySettings.size,
  };
  if (JSON.stringify(stateAfterTiming) !== JSON.stringify(stateBeforeTiming)) {
    throw new Error('timing phases mutated the measurement fixture');
  }

  return {
    id: scenario.id,
    fixture: {
      sweep: scenario.sweep,
      tombstones: scenario.tombstones,
      sessions: scenario.sessions,
      projections: scenario.projections,
      providerMode: scenario.providerMode,
      churn: scenario.churn,
      seed: scenario.seed,
      lookupBatchSize,
      lookupBatchTargetPattern: 'active-session or projection-only fixture IDs in round-robin order, independent of route traversal order',
      recordComposition: {
        totalRecords: scenario.tombstones,
        sameSessionClaudeCodexPairs: scenario.providerMode === 'both'
          ? Math.floor(scenario.tombstones / 2)
          : 0,
        singleProviderRemainder: scenario.providerMode === 'both'
          ? scenario.tombstones % 2
          : scenario.tombstones,
      },
    },
    counts,
    timings,
  };
}

async function createTemporaryRoot() {
  const tempDirectory = await realpath(os.tmpdir());
  const createdPath = await mkdtemp(path.join(tempDirectory, TEMP_PREFIX));
  const root = await realpath(createdPath);
  if (path.dirname(root) !== tempDirectory || !path.basename(root).startsWith(TEMP_PREFIX)) {
    throw new Error('temporary fixture root escaped its owned directory');
  }
  const webPath = path.join(root, 'index.html');
  try {
    await writeFile(webPath, '<!doctype html><title>fixture</title>', { flag: 'wx' });
  } catch (error) {
    const resolved = await realpath(root).catch(() => null);
    if (resolved === root && path.dirname(resolved) === tempDirectory &&
        path.basename(resolved).startsWith(TEMP_PREFIX)) {
      await rm(resolved, { recursive: true, force: false });
    }
    throw error;
  }
  return {
    root,
    webPath,
    async cleanup() {
      const resolved = await realpath(root);
      if (resolved !== root || path.dirname(resolved) !== tempDirectory ||
          !path.basename(resolved).startsWith(TEMP_PREFIX)) {
        throw new Error('temporary fixture cleanup path no longer matches its owned root');
      }
      await rm(resolved, { recursive: true, force: false });
    },
  };
}

async function verifyLifecycleSemantics() {
  const state = new DashboardState();
  const hiddenId = sessionId(312, 'api-hidden', 0);
  const deletedId = sessionId(312, 'api-deleted', 0);
  const clearedId = sessionId(312, 'api-cleared', 0);
  const hiddenAt = FIXED_NOW + 1000;
  const deletedAt = FIXED_NOW + 2000;
  const clearedCodexAt = deletedAt + 1000;

  assert.equal(state.setProjectionHidden('claude', hiddenId, true, hiddenAt), true);
  assert.equal(state.setProjectionHidden('claude', hiddenId, false, hiddenAt + 1), true);
  assert.equal(state.projectionDisplayFor('claude', hiddenId), null);
  assert.equal(state.deleteProjectionDisplay('claude', deletedId, deletedAt), true);
  assert.equal(state.deleteProjectionDisplay('claude', deletedId, deletedAt + 1), false);
  assert.equal(state.clearProjectionDeletionAfterVerifiedWrite('codex', deletedId, deletedAt + 1), false);
  assert.equal(state.clearProjectionDeletionAfterVerifiedWrite('claude', deletedId, deletedAt), false);
  assert.equal(state.projectionDisplayFor('claude', deletedId).deletedAt, new Date(deletedAt).toISOString());
  assert.equal(state.deleteProjectionDisplay('claude', clearedId, deletedAt), true);
  assert.equal(state.deleteProjectionDisplay('codex', clearedId, clearedCodexAt), true);
  assert.equal(state.clearProjectionDeletionAfterVerifiedWrite('codex', clearedId, deletedAt), false);
  assert.equal(state.clearProjectionDeletionAfterVerifiedWrite('codex', clearedId, clearedCodexAt), false);
  assert.equal(state.clearProjectionDeletionAfterVerifiedWrite('codex', clearedId, clearedCodexAt + 1), true);
  assert.equal(state.projectionDisplayFor('claude', clearedId).deletedAt, new Date(deletedAt).toISOString());
  assert.equal(state.projectionDisplayFor('codex', clearedId), null);
  assert.equal(state.setProjectionHidden('codex', hiddenId, true, hiddenAt + 2), true);

  const expectedRecords = [
    { provider: 'claude', session_id: clearedId, deletedAt: new Date(deletedAt).toISOString() },
    { provider: 'claude', session_id: deletedId, deletedAt: new Date(deletedAt).toISOString() },
    { provider: 'codex', session_id: hiddenId, hiddenAt: new Date(hiddenAt + 2).toISOString() },
  ];
  const apiStoreJson = JSON.stringify(state.serializeStore());
  const restored = await loadStateFromStoreJson(apiStoreJson, path.join(os.tmpdir(), `${TEMP_PREFIX}api-roundtrip`));
  const restoredRecords = restored.state.serializeStore().projectionDisplaySettings;
  assert.deepEqual(restoredRecords, expectedRecords);
  assert.deepEqual(restoredRecords, state.serializeStore().projectionDisplaySettings);

  const syntheticStoreJson = createStoreJson(expectedRecords);
  const synthetic = await loadStateFromStoreJson(syntheticStoreJson, path.join(os.tmpdir(), `${TEMP_PREFIX}synthetic-roundtrip`));
  assert.deepEqual(synthetic.state.serializeStore().projectionDisplaySettings, expectedRecords);
  return {
    apiRestoreEqual: true,
    staleAndOtherProviderWritesPreserveDeletion: true,
    newerProviderWriteClearsOnlyItsRecord: true,
    syntheticRestoreEqual: true,
  };
}

function formatHelp() {
  return [
    'Usage: node tools/manual/projection-display-baseline.js [options]',
    '  --sweep all|tombstones|sessions|projections|providers|churn',
    '  --tombstones N[,N...]     Tombstone counts for the N sweep (0..10000)',
    '  --fixed-tombstones N      Fixed N for session/projection sweeps (0..10000)',
    '  --sessions N              Base visible session count (0..2000)',
    '  --projections N           Base validated projection count (0..10000)',
    '  --provider-mode all|claude|codex|both|unknown',
    '  --churn N                 Historical source IDs to retain (0..10000)',
    '  --samples N               Timing samples (1..25)',
    '  --warmup N                Warmup iterations (0..5)',
    '  --seed N                  Deterministic fixture seed (0..2147483647)',
    'Output is JSON on stdout; timing values are environment-dependent.',
  ].join('\n');
}

async function run(options) {
  const scenarios = buildScenarios(options);
  const budget = validateWorkBudget(options, scenarios);
  const lifecycle = await verifyLifecycleSemantics();
  const temporary = await createTemporaryRoot();
  try {
    const results = [];
    for (const scenario of scenarios) {
      results.push(await measureScenario(scenario, options, temporary.root, temporary.webPath));
    }
    return {
      schemaVersion: 2,
      measurementModel: {
        name: 'session-index',
        lookupCalls: 'observed',
        returnedRecords: 'observed',
        bucketVisits: 'not-observed',
      },
      seed: options.seed,
      environment: {
        node: process.version,
        os: os.type(),
        platform: process.platform,
        arch: process.arch,
      },
      options: {
        sweep: options.sweep,
        tombstones: options.tombstones,
        fixedTombstones: options.fixedTombstones,
        sessions: options.sessions,
        projections: options.projections,
        providerMode: options.providerMode,
        churn: options.churn,
        samples: options.samples,
        warmup: options.warmup,
      },
      workBudget: budget,
      fixtureConformance: lifecycle,
      scenarios: results,
    };
  } finally {
    await temporary.cleanup();
  }
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const executeRun = dependencies.run || run;
  let options;
  try {
    options = parseArgs(argv);
    if (!options.help) validateWorkBudget(options);
  } catch (error) {
    stderr.write(`projection-display-baseline: ${error.message}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(`${formatHelp()}\n`);
    return 0;
  }
  try {
    const result = await executeRun(options);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch {
    stderr.write('projection-display-baseline: measurement failed\n');
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    if (exitCode !== 0) process.exitCode = exitCode;
  });
}

module.exports = {
  DEFAULT_OPTIONS,
  LIMITS,
  PROVIDER_MODES,
  SWEEPS,
  buildScenarios,
  countState,
  createMemoryFileSystem,
  createProjectionRecords,
  createReadRouteHarness,
  createScenarioFixture,
  createStoreJson,
  createTemporaryRoot,
  instrumentLookups,
  loadStateFromStoreJson,
  main,
  parseArgs,
  run,
  validateWorkBudget,
  verifyLifecycleSemantics,
};
