'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { AwayState } = require('../src/server/state');
const { createOwnedNativeRunner } = require('../src/server/owned-native-runner');
const { createCommonQuestionSettings } = require('../src/server/common-question-settings');
const { createFakeNativeProcess, defaultProfiles } = require('./support/native-instruction-integration-harness');
const { jsonBody, request, uiHeaders, hookHeaders } = require('./support/server');

function observedIntegration(overrides = {}) {
  const captured = { closeOrder: [], stores: [], ticks: 0 };
  const bindings = [
    ['native-launch-composition', 'createNativeLaunchComposition', (options, value) => {
      captured.composition = value;
      return value;
    }],
    ['durable-delivery-store', 'createDurableDeliveryStore', (options, value) => {
      captured.stores.push({ options, store: value });
      return value;
    }],
    ['instruction-delivery-service', 'createInstructionDeliveryService', (options, value) => {
      captured.instructionOptions = options;
      return Object.freeze({ ...value,
        async close() { captured.closeOrder.push('instruction'); return value.close(); },
      });
    }],
    ['common-question-service', 'createCommonQuestionService', (options, value) => {
      captured.questionOptions = options;
      const service = Object.freeze({ ...value,
        async ready() {
          const result = await value.ready();
          return overrides.readyResult ?? result;
        },
        tick() {
          captured.ticks += 1;
          if (overrides.tickThrows) throw new Error('fixture tick failure');
          if (overrides.tickRejects) return Promise.reject(new Error('fixture tick failure'));
          return value.tick();
        },
        async close() {
          captured.closeOrder.push('question');
          await value.close();
          if (overrides.closeRejects) throw new Error('fixture question close failure');
        },
      });
      captured.questionService = service;
      return service;
    }],
  ];
  const saved = bindings.map(([name]) => {
    const modulePath = require.resolve('../src/server/' + name);
    const module = require(modulePath);
    return { entry: require.cache[modulePath], exports: module };
  });
  const integrationPath = require.resolve('../src/server/native-instruction-service-integration');
  const previousIntegration = require.cache[integrationPath];
  try {
    bindings.forEach(([, method, observe], index) => {
      const original = saved[index].exports;
      saved[index].entry.exports = { ...original, [method]: (options) => observe(options, original[method](options)) };
    });
    delete require.cache[integrationPath];
    return { captured, ...require(integrationPath) };
  } finally {
    saved.forEach(({ entry, exports }) => { entry.exports = exports; });
    if (previousIntegration) require.cache[integrationPath] = previousIntegration;
    else delete require.cache[integrationPath];
  }
}

function settingsFixture(initial = { enabled: false, minimumWaitMs: 300_000 }) {
  let value = initial;
  let state = 'ready';
  let revision = 0;
  let lastListener = null;
  const listeners = new Set();
  return {
    getAutoApplySettings: () => value,
    getStatus: () => ({ status: state, revision: `fixture-${revision}`, reason: null }),
    subscribe(listener) {
      lastListener = listener;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(next, nextState = 'ready') {
      value = next;
      state = nextState;
      revision += 1;
      for (const listener of listeners) listener();
    },
    emitAfterClose: () => lastListener?.(),
    subscriberCount: () => listeners.size,
  };
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'common-question-composition-'));
  const resources = [];
  t.after(async () => {
    for (const resource of resources.reverse()) { try { await resource.close(); } catch {} }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const profiles = defaultProfiles(directory);
  for (const profile of Object.values(profiles)) {
    await fs.mkdir(profile.homePath, { recursive: true });
    await fs.mkdir(profile.cwd, { recursive: true });
  }
  const loaded = observedIntegration(options.observe);
  const settings = options.settings || settingsFixture();
  const away = options.away || new AwayState();
  const processes = [];
  const integrationOptions = {
    profiles, dataDirectory: path.join(directory, 'data'), hostId: 'composition-fixture-host',
    commonQuestions: { away, settings },
    ...(options.now ? { now: options.now } : {}),
    runnerFactory(runnerOptions) {
      const process = createFakeNativeProcess(runnerOptions.provider, runnerOptions.homePath);
      processes.push(process);
      return createOwnedNativeRunner({ ...runnerOptions, spawnImpl: process.spawnImpl,
        timeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 250 } });
    },
    getAuthentication: () => ({ oauthToken: 'fixture-oauth' }),
    onAuthenticationRequired(challenge) { processes.at(-1).completeLogin(challenge.loginId); },
  };
  const serverOptions = { homeDir: path.join(directory, 'dashboard'), claudeHome: path.join(directory, 'claude'), port: 0 };
  return { ...loaded, directory, settings, away, processes, integrationOptions, serverOptions,
    async createNativeInstructionServiceIntegration(input) {
      const integration = await loaded.createNativeInstructionServiceIntegration(input);
      resources.push(integration);
      return integration;
    },
    async startNativeInstructionServer(input) {
      const runtime = await loaded.startNativeInstructionServer(input);
      resources.push(runtime);
      return runtime;
    },
  };
}

async function startNative(f, integration, provider = 'codex') {
  const started = await integration.native.startLaunch({
    launchId: `${provider}-launch`, runId: `${provider}-run`, attemptId: `${provider}-attempt`,
    profileId: provider, origin: 'standalone', purpose: 'agent', inputText: 'composition fixture',
  });
  const writer = f.captured.composition.writerFor(started.result.launchRef);
  assert.ok(writer);
  return { started, writer };
}

function registration(writer, questionId = 'public-question') {
  return { writer, questionId, timeoutMinutes: 1, questions: [{
    id: 'choice', text: 'Choose an option', mode: 'single',
    options: [{ id: 'a', label: 'Option A', description: '' }],
    allowFreeText: false, recommendedOptionId: 'a',
  }] };
}

function postQuestion(runtime, operation, body) {
  return request(runtime.info.port, { method: 'POST', path: `/api/sessions/pending/questions/${operation}`,
    headers: hookHeaders(runtime.info.secret), body: JSON.stringify(body) });
}

test('absent or incomplete common dependencies retain the instruction-only configuration', async (t) => {
  const f = await fixture(t);
  for (const config of [undefined, {}, { away: f.away }, { settings: f.settings }]) {
    const input = { ...f.integrationOptions };
    if (config === undefined) delete input.commonQuestions;
    else input.commonQuestions = config;
    const integration = await f.createNativeInstructionServiceIntegration(input);
    assert.equal(integration.questionService, null);
    assert.equal(integration.commonQuestionJournalPath, null);
    assert.equal(integration.getStatus().commonQuestions.status, 'unconfigured');
    assert.equal(await integration.service.ready().then((value) => value.ready), true);
    await integration.close();
  }
  await assert.rejects(fs.access(path.join(f.integrationOptions.dataDirectory, 'common-question-journal.json')), { code: 'ENOENT' });
});

for (const provider of ['claude', 'codex']) {
  test(`${provider} common questions use the native registries and one checkpoint through verified HTTP delivery`, async (t) => {
    const f = await fixture(t);
    const runtime = await f.startNativeInstructionServer({ integrationOptions: f.integrationOptions, serverOptions: f.serverOptions });
    t.after(() => runtime.close());
    const { writer } = await startNative(f, runtime, provider);
    assert.equal(runtime.away, f.away);
    assert.equal(runtime.questionService, f.captured.questionService);
    assert.equal(f.captured.stores.length, 1);
    const { store, options: storeOptions } = f.captured.stores[0];
    assert.equal(f.captured.questionOptions.deliveryStore, store);
    assert.equal(f.captured.instructionOptions.deliveryStore, store);
    for (const name of ['registrationRegistry', 'launchRegistry', 'runtimeRegistry']) {
      assert.equal(f.captured.questionOptions[name], storeOptions[name]);
    }
    assert.equal(f.captured.questionOptions.away, f.away);
    const spoofed = await postQuestion(runtime, 'register', registration({ ...writer, token: 'unverified' }));
    assert.equal(spoofed.status, 403);
    const registered = await postQuestion(runtime, 'register', registration(writer));
    assert.equal(registered.status, 200);
    const question = jsonBody(registered).question;
    const replay = await postQuestion(runtime, 'register', registration(writer));
    assert.equal(jsonBody(replay).question.internalQuestionId, question.internalQuestionId);
    const sessionId = f.captured.questionOptions.registrationRegistry.authorizeWriter(writer).sessionId;
    const answer = await request(runtime.info.port, { method: 'POST', path: `/api/decisions/${question.internalQuestionId}/answer`,
      headers: uiHeaders(runtime.info, `http://127.0.0.1:${runtime.info.port}`), body: JSON.stringify({ session_id: sessionId,
        execution_id: question.executionId, answers: [{ questionId: 'choice', optionIds: ['a'], freeText: null }] }) });
    assert.equal(answer.status, 200);
    const delivered = await postQuestion(runtime, 'answer-poll', { writer, questionId: 'public-question' });
    assert.equal(delivered.status, 200);
    assert.equal(jsonBody(delivered).status.outcome, 'sent');
    const repeated = await postQuestion(runtime, 'answer-poll', { writer, questionId: 'public-question' });
    assert.equal(jsonBody(repeated).delivery, null);
    assert.deepEqual(f.processes.at(-1).state.instructionWrites, []);
    assert.equal(f.processes.length, 1);
    assert.equal(f.processes[0].state.spawnCount, 1);
    const checkpoint = JSON.parse(await fs.readFile(storeOptions.filePath, 'utf8'));
    assert.equal(JSON.stringify(checkpoint).includes('public-question'), false);
    assert.equal((await store.snapshot()).deliveries.filter((item) => item.kind === 'question').length, 1);
  });
}

for (const provider of ['claude', 'codex']) for (const selected of [false, true]) {
  test(`${provider} fresh native registries quarantine ${selected ? 'selected' : 'unselected'} saved questions while retaining both journals and the shared checkpoint`, async (t) => {
    const f = await fixture(t);
    const integration = await f.createNativeInstructionServiceIntegration(f.integrationOptions);
    t.after(async () => { try { await integration.close(); } catch {} });
    const { started, writer } = await startNative(f, integration, provider);
    const { writer: ignoredWriter, ...input } = registration(writer);
    const registered = await integration.questionService.register(writer, { ...input, category: 'ordinary' });
    if (selected) {
      await integration.questionService.submitAnswer(registered.question.internalQuestionId,
        { answers: [{ questionId: 'choice', optionIds: ['a'], freeText: null }] });
    }
    await integration.service.create({ deliveryAttemptId: 'instruction-delivery', launchRef: started.result.launchRef,
      logicalMessageId: 'instruction-message', revision: 0, text: 'Saved instruction', mode: 'steer',
      expectedTurnId: `${provider}-native-turn-1` });
    await integration.close();
    const paths = [integration.commonQuestionJournalPath, integration.journalPath, integration.checkpointPath];
    const before = await Promise.all(paths.map((filePath) => fs.readFile(filePath, 'utf8')));
    const reopened = await f.createNativeInstructionServiceIntegration(f.integrationOptions);
    t.after(async () => { try { await reopened.close(); } catch {} });
    await reopened.questionService.ready();
    const after = await Promise.all(paths.map((filePath) => fs.readFile(filePath, 'utf8')));
    assert.deepEqual(after, before);
    assert.equal(JSON.parse(after[0]).questions.length, 1);
    assert.equal(JSON.parse(after[1]).instructions.length, 1);
    assert.equal(reopened.questionService.getQuarantineDiagnostics().quarantinedCount, 1);
    const dashboard = await reopened.questionService.dashboardSnapshot();
    assert.equal(dashboard.questions[0].quarantined, true);
    assert.equal(dashboard.questions[0].deliveryState, selected ? 'available' : null);
    assert.equal(reopened.getStatus().commonQuestions.quarantine.quarantinedCount, 1);
    await assert.rejects(reopened.questionService.submitAnswer(registered.question.internalQuestionId,
      { answers: [{ questionId: 'choice', optionIds: ['a'], freeText: null }] }), { code: 'question_quarantined' });
    await assert.rejects(reopened.questionService.hold(registered.question.internalQuestionId, true),
      { code: 'question_quarantined' });
    await assert.rejects(reopened.questionService.cancel(registered.question.internalQuestionId),
      { code: 'question_quarantined' });
    assert.deepEqual(await Promise.all(paths.map((filePath) => fs.readFile(filePath, 'utf8'))), before);
    assert.deepEqual(f.processes.at(-1).state.instructionWrites, []);
  });
}

test('invalid question journals reject readiness, keep their bytes, and release the instruction journal', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.integrationOptions.dataDirectory, { recursive: true });
  const questionPath = path.join(f.integrationOptions.dataDirectory, 'common-question-journal.json');
  await fs.writeFile(questionPath, '{');
  await assert.rejects(f.createNativeInstructionServiceIntegration(f.integrationOptions));
  assert.equal(await fs.readFile(questionPath, 'utf8'), '{');
  assert.deepEqual(f.captured.closeOrder, ['question', 'instruction']);
  assert.equal(f.settings.subscriberCount(), 0);
  const { commonQuestions, ...instructionOnly } = f.integrationOptions;
  const integration = await f.createNativeInstructionServiceIntegration(instructionOnly);
  await integration.close();
});

test('successful settings notifications reevaluate registered questions and unsubscribe before closing shared services', async (t) => {
  let now = 1000;
  const away = { snapshot: () => ({ enabled: true, since: 0 }) };
  const settings = settingsFixture({ enabled: true, minimumWaitMs: 600_000 });
  const f = await fixture(t, { away, settings, now: () => now });
  const integration = await f.createNativeInstructionServiceIntegration(f.integrationOptions);
  t.after(async () => { try { await integration.close(); } catch {} });
  const { writer } = await startNative(f, integration);
  const input = registration(writer);
  const registered = await integration.questionService.register(writer, {
    questionId: input.questionId, questions: input.questions, timeoutMinutes: input.timeoutMinutes, category: 'ordinary',
  });
  now = 301_001;
  assert.equal((await integration.questionService.status(writer, input.questionId)).selectionSource, null);
  settings.update({ enabled: true, minimumWaitMs: 300_000 });
  await integration.questionService.flush();
  const current = await integration.questionService.status(writer, input.questionId);
  assert.equal(current.selectionSource, 'away-default');
  assert.equal(current.internalQuestionId, registered.question.internalQuestionId);
  await integration.close();
  assert.equal(settings.subscriberCount(), 0);
  const ticks = f.captured.ticks;
  settings.emitAfterClose();
  assert.equal(f.captured.ticks, ticks);
  assert.deepEqual(f.captured.closeOrder, ['question', 'instruction']);
  assert.equal(integration.getStatus().commonQuestions.status, 'closed');
});

test('persisted settings start disabled, notify the factory after saving, and remain writable without its subscriber after close', async (t) => {
  const f = await fixture(t);
  const settings = await createCommonQuestionSettings({ dataDirectory: f.integrationOptions.dataDirectory });
  const integration = await f.createNativeInstructionServiceIntegration({ ...f.integrationOptions,
    commonQuestions: { away: f.away, settings } });
  const initialStatus = settings.getStatus();
  assert.equal(initialStatus.status, 'missing');
  assert.equal(settings.getAutoApplySettings().enabled, false);
  assert.equal(f.captured.questionOptions.getAutoApplySettings(), null);
  assert.deepEqual(integration.getStatus().commonQuestions.settings, initialStatus);
  const { writer } = await startNative(f, integration);
  const { writer: ignoredWriter, ...input } = registration(writer);
  await integration.questionService.register(writer, { ...input, category: 'ordinary' });
  const initialJournal = JSON.parse(await fs.readFile(integration.commonQuestionJournalPath, 'utf8'));
  assert.equal(initialJournal.questions[0].autoApplyEnabledAtRegistration, false);

  const saved = await settings.updateSettings({ expectedRevision: initialStatus.revision,
    enabled: true, minimumWaitMs: 600_000 });
  await integration.questionService.flush();
  assert.equal(f.captured.ticks, 1);
  assert.equal(saved.status.status, 'ready');
  assert.notEqual(saved.status.revision, initialStatus.revision);
  assert.deepEqual(settings.getStatus(), saved.status);
  assert.deepEqual(integration.getStatus().commonQuestions.settings, saved.status);
  assert.deepEqual(settings.getAutoApplySettings(), { enabled: true, minimumWaitMs: 600_000 });
  assert.deepEqual(f.captured.questionOptions.getAutoApplySettings(), saved.autoApply);
  await integration.questionService.register(writer, { ...input, questionId: 'enabled-question', category: 'ordinary' });
  const enabledJournal = JSON.parse(await fs.readFile(integration.commonQuestionJournalPath, 'utf8'));
  assert.equal(enabledJournal.questions.find((question) => question.questionId === 'enabled-question').autoApplyEnabledAtRegistration, true);

  const settingsPath = path.join(f.integrationOptions.dataDirectory, 'common-question-settings.json');
  const savedBytes = await fs.readFile(settingsPath);
  await integration.close();
  assert.deepEqual(await fs.readFile(settingsPath), savedBytes);
  const afterClose = await settings.updateSettings({ expectedRevision: saved.status.revision,
    enabled: false, minimumWaitMs: 600_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.captured.ticks, 1);
  assert.equal(afterClose.autoApply.enabled, false);
  assert.notEqual(afterClose.status.revision, saved.status.revision);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')),
    { schemaVersion: 1, autoApply: { enabled: false, minimumWaitMs: 600_000 } });
});

for (const tickFailure of ['tickThrows', 'tickRejects']) {
  test(`settings listener observes ${tickFailure} without throwing or leaking rejection`, async (t) => {
    const f = await fixture(t, { observe: { [tickFailure]: true } });
    const integration = await f.createNativeInstructionServiceIntegration(f.integrationOptions);
    t.after(() => integration.close());
    assert.doesNotThrow(() => f.settings.update({ enabled: false, minimumWaitMs: 300_000 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.captured.ticks, 1);
  });
}

for (const outcome of ['promise', 'throw']) {
  test(`settings getter ${outcome} keeps manual questions configured with automatic application disabled`, async (t) => {
    const settings = settingsFixture();
    settings.getAutoApplySettings = () => {
      if (outcome === 'throw') throw new Error('fixture getter failure');
      return Promise.reject(new Error('fixture getter rejection'));
    };
    const f = await fixture(t, { settings });
    const integration = await f.createNativeInstructionServiceIntegration(f.integrationOptions);
    t.after(() => integration.close());
    assert.equal(integration.getStatus().commonQuestions.status, 'ready');
    const { writer } = await startNative(f, integration);
    const { writer: ignoredWriter, ...input } = registration(writer);
    await integration.questionService.register(writer, { ...input, category: 'ordinary' });
    const journal = JSON.parse(await fs.readFile(integration.commonQuestionJournalPath, 'utf8'));
    assert.equal(journal.questions[0].autoApplyEnabledAtRegistration, false);
  });
}

test('unsafe settings diagnostics override an enabled getter and notify the existing question service', async (t) => {
  const settings = settingsFixture({ enabled: true, minimumWaitMs: 300_000 });
  const f = await fixture(t, { settings });
  const integration = await f.createNativeInstructionServiceIntegration(f.integrationOptions);
  t.after(() => integration.close());
  assert.equal(f.captured.questionOptions.getAutoApplySettings().enabled, true);
  for (const status of ['missing', 'invalid', 'unavailable', 'changed']) {
    settings.update({ enabled: true, minimumWaitMs: 300_000 }, status);
    assert.equal(f.captured.questionOptions.getAutoApplySettings(), null);
    assert.equal(integration.getStatus().commonQuestions.settings.status, status);
  }
  await integration.questionService.flush();
  assert.equal(f.captured.ticks, 4);
});

test('integration settings diagnostics expose only status revision and reason', async (t) => {
  const settings = settingsFixture();
  settings.getStatus = () => ({ status: 'invalid', revision: 'fixture-1', reason: 'invalid_settings_json',
    filePath: 'private-path', contents: 'private-contents' });
  const f = await fixture(t, { settings });
  const integration = await f.createNativeInstructionServiceIntegration(f.integrationOptions);
  t.after(() => integration.close());
  const status = integration.getStatus().commonQuestions;
  assert.equal(status.status, 'ready');
  assert.deepEqual(status.settings, { status: 'invalid', revision: 'fixture-1', reason: 'invalid_settings_json' });
  assert.deepEqual(Object.keys(status.quarantine).sort(), ['quarantinedCount', 'reason', 'remainingBytes',
    'remainingCount', 'reservedBytes', 'status']);
  assert.equal(status.quarantine.status, 'ready');
  assert.equal(status.quarantine.reason, null);
  assert.equal(status.quarantine.quarantinedCount, 0);
  assert.equal(Number.isSafeInteger(status.quarantine.reservedBytes), true);
  assert.equal(Number.isSafeInteger(status.quarantine.remainingBytes), true);
  assert.equal(Number.isSafeInteger(status.quarantine.remainingCount), true);
  assert.equal(JSON.stringify(status).includes(f.integrationOptions.dataDirectory), false);
  assert.equal(f.captured.questionOptions.getAutoApplySettings(), null);
});

test('question readiness diagnostics reject initialization and release both journal owners', async (t) => {
  const f = await fixture(t, { observe: { readyResult: { ready: false } } });
  await assert.rejects(f.createNativeInstructionServiceIntegration(f.integrationOptions), { code: 'common_question_service_unavailable' });
  assert.deepEqual(f.captured.closeOrder, ['question', 'instruction']);
  assert.equal(f.settings.subscriberCount(), 0);
  const clean = observedIntegration();
  const integration = await clean.createNativeInstructionServiceIntegration(f.integrationOptions);
  await integration.close();
});

test('a failed question close still closes instructions once and removes the settings subscriber', async (t) => {
  const f = await fixture(t, { observe: { closeRejects: true } });
  const integration = await f.createNativeInstructionServiceIntegration(f.integrationOptions);
  await assert.rejects(integration.close(), /fixture question close failure/);
  await assert.rejects(integration.close(), /fixture question close failure/);
  assert.deepEqual(f.captured.closeOrder, ['question', 'instruction']);
  assert.equal(f.settings.subscriberCount(), 0);
});

test('native HTTP startup rejects a different away instance before constructing persistent services', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.startNativeInstructionServer({ integrationOptions: f.integrationOptions,
    serverOptions: { ...f.serverOptions, away: new AwayState() } }), { code: 'common_question_away_mismatch' });
  assert.equal(f.captured.stores.length, 0);
});

test('native HTTP startup failure closes the configured question service and removes its settings subscriber', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.startNativeInstructionServer({ integrationOptions: f.integrationOptions,
    serverOptions: { ...f.serverOptions, port: -1 } }), /port must be between/);
  assert.equal(f.settings.subscriberCount(), 0);
  const integration = await f.createNativeInstructionServiceIntegration(f.integrationOptions);
  await integration.close();
});
